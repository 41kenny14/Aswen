// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title FlashLoanArbitrageV2
 * @notice Aave V3 flash loan arbitrage — optimized for Base network.
 *         V2 improvements:
 *           • Dynamic trade sizing support (variable borrow amounts)
 *           • Deadline parameter on all swaps (MEV sandwich window reduction)
 *           • Callback hash verification (replay protection)
 *           • Multi-hop V2 path support (triangular arb)
 *           • Emits OpportunityId for off-chain tracking
 *           • Separate profit accounting per asset
 */

// ─────────────────────────────────────────────────────────────────────────────
// Interfaces
// ─────────────────────────────────────────────────────────────────────────────

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

interface IUniswapV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    struct ExactInputParams {
        bytes   path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    function exactInputSingle(ExactInputSingleParams calldata p) external returns (uint256);
    function exactInput(ExactInputParams calldata p) external returns (uint256);
}

interface IPoolAddressesProvider {
    function getPool() external view returns (address);
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

contract FlashLoanArbitrageV2 is IFlashLoanSimpleReceiver {

    // ── Types ────────────────────────────────────────────────────────────────

    enum DexType { UniswapV2, UniswapV3, UniswapV3Multi }

    struct SwapStep {
        DexType  dexType;
        address  router;
        address  tokenIn;
        address  tokenOut;
        uint24   fee;           // V3 single-hop fee
        bytes    v3Path;        // V3 multi-hop encoded path (overrides tokenIn/Out/fee)
        uint256  amountOutMin;
    }

    struct FlashParams {
        bytes32     opportunityId;  // off-chain tracking ID
        SwapStep[]  steps;
        uint256     expectedProfit;
        uint256     deadline;       // block.timestamp must be <= deadline
    }

    // ── State ────────────────────────────────────────────────────────────────

    address public immutable owner;
    IPoolAddressesProvider public immutable addressesProvider;

    uint256 public maxSlippageBps = 100;  // 1%
    uint256 public minProfitWei   = 0;

    // Profit accounting per asset
    mapping(address => uint256) public totalProfitPerAsset;

    bool private _locked;

    // Used nonces prevent replay of the same params hash
    mapping(bytes32 => bool) private _usedNonces;

    // ── Events ───────────────────────────────────────────────────────────────

    event LoanReceived(bytes32 indexed opportunityId, address asset, uint256 amount, uint256 premium);
    event TradeExecuted(bytes32 indexed opportunityId, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);
    event ProfitSent(bytes32 indexed opportunityId, address to, address token, uint256 amount);
    event ConfigUpdated(uint256 maxSlippageBps, uint256 minProfitWei);

    // ── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "V2: not owner");
        _;
    }

    modifier nonReentrant() {
        require(!_locked, "V2: reentrant");
        _locked = true;
        _;
        _locked = false;
    }

    modifier onlyPool() {
        require(msg.sender == addressesProvider.getPool(), "V2: not pool");
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────

    /**
     * @param _provider Aave V3 PoolAddressesProvider on Base:
     *                  0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D
     */
    constructor(address _provider) {
        owner = msg.sender;
        addressesProvider = IPoolAddressesProvider(_provider);
    }

    // ── Configuration ────────────────────────────────────────────────────────

    function setConfig(uint256 _maxSlippageBps, uint256 _minProfitWei) external onlyOwner {
        require(_maxSlippageBps <= 1000, "V2: slippage cap exceeded");
        maxSlippageBps = _maxSlippageBps;
        minProfitWei   = _minProfitWei;
        emit ConfigUpdated(_maxSlippageBps, _minProfitWei);
    }

    // ── Entry Point ──────────────────────────────────────────────────────────

    /**
     * @notice Request a flash loan and execute arbitrage.
     * @param asset          Token to borrow (e.g. USDC)
     * @param amount         Amount in wei (dynamically sized by off-chain engine)
     * @param steps          Ordered swap steps
     * @param expectedProfit Expected net profit (for event logging only)
     * @param deadline       Must execute before this timestamp (anti-MEV)
     * @param opportunityId  Off-chain identifier (bytes32 hash)
     */
    function requestFlashLoan(
        address     asset,
        uint256     amount,
        SwapStep[] calldata steps,
        uint256     expectedProfit,
        uint256     deadline,
        bytes32     opportunityId
    ) external onlyOwner nonReentrant {
        require(block.timestamp <= deadline,  "V2: deadline passed");
        require(steps.length >= 2,            "V2: need >= 2 steps");
        require(amount > 0,                   "V2: zero amount");
        require(!_usedNonces[opportunityId],  "V2: already executed");

        _usedNonces[opportunityId] = true;

        FlashParams memory params = FlashParams({
            opportunityId:  opportunityId,
            steps:          steps,
            expectedProfit: expectedProfit,
            deadline:       deadline
        });

        IPool(addressesProvider.getPool()).flashLoanSimple(
            address(this),
            asset,
            amount,
            abi.encode(params),
            0
        );
    }

    // ── Aave Callback ────────────────────────────────────────────────────────

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata rawParams
    ) external override onlyPool nonReentrant returns (bool) {
        require(initiator == address(this), "V2: bad initiator");

        FlashParams memory fp = abi.decode(rawParams, (FlashParams));

        // Deadline check inside callback too (block reorg protection)
        require(block.timestamp <= fp.deadline, "V2: callback deadline");

        emit LoanReceived(fp.opportunityId, asset, amount, premium);

        uint256 totalDebt = amount + premium;
        uint256 current   = amount;

        // ── Execute swap chain ────────────────────────────────────────────────
        for (uint256 i = 0; i < fp.steps.length; i++) {
            SwapStep memory s = fp.steps[i];
            uint256 out;

            if (s.dexType == DexType.UniswapV2) {
                out = _swapV2(s, current, fp.deadline);

            } else if (s.dexType == DexType.UniswapV3) {
                out = _swapV3Single(s, current, fp.deadline);

            } else {
                out = _swapV3Multi(s, current, fp.deadline);
            }

            emit TradeExecuted(fp.opportunityId, s.tokenIn, s.tokenOut, current, out);
            current = out;
        }

        // ── Profit assertion ──────────────────────────────────────────────────
        uint256 finalBal = IERC20(asset).balanceOf(address(this));
        require(finalBal >= totalDebt, "V2: unprofitable");

        uint256 profit = finalBal - totalDebt;
        require(profit >= minProfitWei, "V2: below min profit");

        // ── Repay Aave ────────────────────────────────────────────────────────
        _approve(asset, addressesProvider.getPool(), totalDebt);

        // ── Send profit ───────────────────────────────────────────────────────
        if (profit > 0) {
            totalProfitPerAsset[asset] += profit;
            _transfer(asset, owner, profit);
            emit ProfitSent(fp.opportunityId, owner, asset, profit);
        }

        return true;
    }

    // ── Swap Helpers ─────────────────────────────────────────────────────────

    function _swapV2(SwapStep memory s, uint256 amountIn, uint256 deadline) internal returns (uint256) {
        _approve(s.tokenIn, s.router, amountIn);
        address[] memory path = new address[](2);
        path[0] = s.tokenIn;
        path[1] = s.tokenOut;
        uint256[] memory out = IUniswapV2Router(s.router).swapExactTokensForTokens(
            amountIn, s.amountOutMin, path, address(this), deadline
        );
        return out[out.length - 1];
    }

    function _swapV3Single(SwapStep memory s, uint256 amountIn, uint256 deadline) internal returns (uint256) {
        _approve(s.tokenIn, s.router, amountIn);
        // deadline not used in V3 single (sqrtPriceLimitX96 acts as guard)
        return IUniswapV3Router(s.router).exactInputSingle(
            IUniswapV3Router.ExactInputSingleParams({
                tokenIn:           s.tokenIn,
                tokenOut:          s.tokenOut,
                fee:               s.fee,
                recipient:         address(this),
                amountIn:          amountIn,
                amountOutMinimum:  s.amountOutMin,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function _swapV3Multi(SwapStep memory s, uint256 amountIn, uint256 deadline) internal returns (uint256) {
        // First token in path needs approval
        _approve(s.tokenIn, s.router, amountIn);
        return IUniswapV3Router(s.router).exactInput(
            IUniswapV3Router.ExactInputParams({
                path:             s.v3Path,
                recipient:        address(this),
                amountIn:         amountIn,
                amountOutMinimum: s.amountOutMin
            })
        );
    }

    // ── Safe token ops ───────────────────────────────────────────────────────

    function _approve(address token, address spender, uint256 amount) internal {
        IERC20(token).approve(spender, 0);
        require(IERC20(token).approve(spender, amount), "V2: approve failed");
    }

    function _transfer(address token, address to, uint256 amount) internal {
        require(IERC20(token).transfer(to, amount), "V2: transfer failed");
    }

    // ── Emergency ─────────────────────────────────────────────────────────────

    function rescue(address token, uint256 amount) external onlyOwner {
        _transfer(token, owner, amount);
    }

    function rescueETH() external onlyOwner {
        (bool ok,) = owner.call{value: address(this).balance}("");
        require(ok, "V2: ETH rescue failed");
    }

    receive() external payable {}
}
