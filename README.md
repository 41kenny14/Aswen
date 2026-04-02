# Base Arb Engine V2

Motor de arbitraje con **flash loans de Aave V3** para **Base L2**, con ejecución event-driven, filtros de riesgo y envío MEV-aware.

## ¿Qué hace este código?

A nivel funcional, el proyecto hace esto:

1. **Escucha eventos on-chain en tiempo real por WebSocket** (`Sync` en pools V2 y `Swap` en pools V3).
2. **Detecta diferencias de precio (spread)** entre DEXs para un mismo par.
3. **Filtra oportunidades** (liquidez mínima, riesgo honeypot, slippage máximo).
4. **Calcula tamaño óptimo dinámico** del flash loan para maximizar utilidad neta.
5. **Simula la operación completa** (incluyendo fee de Aave y costo de gas).
6. **Rankea oportunidades y evita ejecuciones concurrentes conflictivas**.
7. **Ejecuta on-chain** llamando al contrato `FlashLoanArbitrageV2`.
8. **Protege contra MEV** enviando por Private RPC / Relayer / Public RPC (fallback).
9. **Mantiene watchdog/failsafe 24/7** con circuit breaker, health checks y métricas.

---

## Arquitectura (resumen completo)

### 1) Entry point (`index.js`)

`index.js` levanta todo el sistema en este orden:

- Valida configuración de entorno.
- Crea provider HTTP + WS.
- Corre el **Preloader** (camino “frío”).
- Inicia el **Scanner** (camino “caliente”).
- Inicia **Failsafe**.
- Maneja shutdown limpio (`SIGINT`, `SIGTERM`).

### 2) Preloader (`preloader/index.js`)

Hace el trabajo pesado una sola vez al inicio para que el hot path sea liviano:

- precarga wallet,
- obtiene el pool de Aave desde `PoolAddressesProvider`,
- resuelve metadata de tokens (decimals/symbol) por multicall,
- descubre pools V2/V3 para todos los pares y DEX configurados,
- preinstancia contratos HTTP y WS,
- preconstruye rutas de arbitraje.

La idea central: **cero cómputo de rutas en ejecución**.

### 3) Scanner (`engine/scanner.js`)

Funciona solo por eventos WS (sin polling):

- mantiene precios/reservas en memoria,
- al actualizarse un pool, evalúa rutas afectadas en paralelo,
- exige datos recientes (rechaza `stale`),
- calcula spread y dispara el pipeline si supera umbral,
- incorpora heartbeat + reconexión exponencial.

### 4) Pipeline de ejecución (`engine/pipeline.js`)

Para cada oportunidad pasa por:

1. Liquidity filter,
2. Honeypot filter,
3. estimación de gas,
4. dynamic sizing,
5. slippage check,
6. simulación completa,
7. scoring/ranking,
8. lock de ejecución (1 TX a la vez),
9. envío de transacción.

### 5) Filtros (`filters/*`)

- **liquidity.js**: valida reservas/liquidez efectiva y price impact.
- **honeypot.js**: cachea validación de token + estima “tax” por round-trip.
- **slippage.js**: modela salida y slippage para V2 y aproximación V3.

### 6) Simulador (`simulation/index.js`)

Simula la secuencia completa antes de enviar TX:

- fee de flash loan,
- buy leg + sell leg,
- costo de gas,
- profit neto,
- validación contra `MIN_PROFIT` y `MAX_GAS_COST`.

### 7) Optimización (`sizing/index.js`, `ranking/index.js`)

- **Sizing**: búsqueda por grilla + golden section para `optimalAmount`.
- **Ranking**: score compuesto por profit, eficiencia, slippage, spread y fallos históricos.

### 8) Envío MEV-aware (`mev/sender.js`)

Prioridad de envío:

1. `PRIVATE_RPC_URL`
2. `RELAYER_URL`
3. RPC público

Incluye estrategia de gas dinámica y confirmación de receipt.

### 9) Contrato (`contracts/FlashLoanArbitrageV2.sol`)

- Solicita flash loan a Aave (`requestFlashLoan`).
- Ejecuta secuencia de swaps (V2/V3/V3 multi-hop).
- Verifica rentabilidad (`finalBal >= debt` + `minProfitWei`).
- Reembolsa Aave y transfiere profit al owner.
- Tiene guardas: `onlyOwner`, `onlyPool`, `nonReentrant`, `deadline`, `nonce/opportunityId` anti-replay.

---

## Requisitos

- Node.js **>= 18**
- npm
- acceso RPC de Base (HTTP y WS)
- wallet con fondos para gas
- contrato desplegado `FlashLoanArbitrageV2`

---

## Variables de entorno (.env)

Crear `.env` en la raíz. Variables requeridas por código:

```env
# Red
RPC_URL_BASE=https://...
WS_URL_BASE=wss://...

# Wallet/Contrato
PRIVATE_KEY=0x...
CONTRACT_ADDRESS=0x...

# Monto de préstamo (wei de token base, típicamente USDC 6 decimales)
FLASH_LOAN_AMOUNT=1000000000

# Pares a monitorear
# Formato por item: SYMBOL:TOKEN0:DEC0:TOKEN1:DEC1
TOKEN_PAIRS=USDC-WETH:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913:6:0x4200000000000000000000000000000000000006:18

# DEX configs
# Formato por item: NAME:VERSION:FACTORY:ROUTER
DEX_CONFIGS=UNISWAPV3:3:0x...:0x...,SUSHI:2:0x...:0x...
```

Opcionales relevantes:

```env
# MEV
PRIVATE_RPC_URL=
RELAYER_URL=
RELAYER_AUTH=

# Umbrales
MIN_SPREAD_PERCENT=0.3
MIN_PROFIT=1.0
MAX_GAS_COST=0.005
MAX_GAS_PRICE_GWEI=0.05
MAX_SLIPPAGE=1.0
MIN_LIQUIDITY_THRESHOLD=50000
MAX_TAX_THRESHOLD=0.05

# Otros
AAVE_ADDRESSES_PROVIDER=0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D
BASE_TOKEN=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
ETH_PRICE_USD=3000
LOG_LEVEL=info
WEBHOOK_URL=
BASESCAN_API_KEY=
```

> ✅ Recomendado: primero copiá la plantilla incluida en el repo:
>
> ```bash
> cp .env.example .env
> ```

### Cómo completar lo que falta (paso a paso)

A continuación, qué campos ya quedan listos y cuáles necesitás completar manualmente:

- **Ya prellenados (no sensibles)** en `.env.example`:
  - `RPC_URL_BASE` (endpoint público Base),
  - `AAVE_ADDRESSES_PROVIDER`,
  - `BASE_TOKEN` (USDC Base),
  - umbrales operativos (`MIN_SPREAD_PERCENT`, `MAX_SLIPPAGE`, etc.),
  - ejemplo funcional de `TOKEN_PAIRS` para USDC/WETH.

- **Debés completar sí o sí**:
  1. `PRIVATE_KEY` (sensible),
  2. `CONTRACT_ADDRESS` (tu deploy),
  3. `WS_URL_BASE` (endpoint WSS de proveedor RPC),
  4. `DEX_CONFIGS` (factories + routers oficiales de los DEX que quieras operar).

#### 1) Conseguir `WS_URL_BASE`

1. Crear cuenta en un proveedor con Base WebSocket (Alchemy, Infura, QuickNode, Ankr, etc.).
2. Crear una app/proyecto para red **Base Mainnet**.
3. Copiar el endpoint **WSS** (empieza con `wss://`).
4. Pegarlo en `.env` como `WS_URL_BASE=...`.

#### 2) Conseguir `CONTRACT_ADDRESS`

Tenés dos opciones:

- Si ya lo desplegaste: usar esa dirección.
- Si no, desplegar con:

```bash
npm run deploy
```

Al finalizar, el script imprime la dirección; copiála en `CONTRACT_ADDRESS`.

#### 3) Conseguir `DEX_CONFIGS` correctamente

Para cada DEX necesitás:
- `factory`,
- `router`,
- versión (`2` o `3`).

Formato final:

```env
DEX_CONFIGS=NOMBRE:VERSION:FACTORY:ROUTER,NOMBRE2:VERSION:FACTORY:ROUTER
```

Pasos recomendados para obtenerlos bien:

1. Ir a documentación oficial del DEX (sección “Deployments” en Base).
2. Verificar cada address en **basescan.org** (contrato verificado y nombre correcto).
3. Probar lectura mínima con `cast call`/script o en BaseScan Read Contract (por ejemplo `getPool` o `getPair`).
4. Recién ahí cargarlo en `DEX_CONFIGS`.

#### 4) Validación rápida de `.env` antes de correr

1. Revisar que no queden placeholders (`TU_ENDPOINT`, `REEMPLAZAR`, `0xFACTORY...`).
2. Confirmar que `FLASH_LOAN_AMOUNT` esté en unidades correctas del token base (USDC = 6 decimales).
3. Arrancar el bot y validar que el preloader resuelva pools sin errores:

```bash
npm start
```

Si el preloader informa `Resolved 0 pools`, normalmente el problema está en `DEX_CONFIGS` o `TOKEN_PAIRS`.

---

## ¿Cómo dejarlo corriendo?

## 1) Instalar dependencias

```bash
npm install
```

## 2) Compilar contrato

```bash
npm run compile
```

## 3) (Opcional) Desplegar contrato

```bash
npm run deploy
```

Tomar la address y colocarla en `.env` como `CONTRACT_ADDRESS`.

## 4) Ejecutar el motor

```bash
npm start
```

Esto inicia:
- precarga de estado,
- scanner WS,
- watchdog failsafe,
- monitoreo 24/7.

## 5) (Opcional) Dashboard en otra terminal

```bash
npm run dashboard
```

Lee `logs/opportunities.log` y muestra decisiones recientes.

---

## Ejecución continua recomendada (producción)

Usar un process manager para que reinicie automáticamente si cae.

Ejemplo con PM2:

```bash
npm i -g pm2
pm2 start index.js --name base-arb-v2
pm2 logs base-arb-v2
pm2 save
```

---

## Testing

```bash
npm test
```

Los tests usan Hardhat sobre fork de Base (`network hardhat`) y requieren `RPC_URL_BASE` válido.

---

## Riesgos / observaciones importantes

- Opera con dinero real y está expuesto a riesgo de mercado/ejecución.
- Varias métricas V3 usan aproximaciones (no tick math completo), por lo que conviene validar supuestos en producción.
- La protección MEV mejora con `PRIVATE_RPC_URL` o `RELAYER_URL`; en público hay más riesgo de frontrun.
- Umbrales (`MIN_PROFIT`, `MAX_GAS_COST`, `MAX_SLIPPAGE`) deben calibrarse por par y condiciones actuales de mercado.

---

## Estructura del proyecto

```text
contracts/      # smart contract de arbitraje flash loan
engine/         # scanner + pipeline
failsafe/       # watchdog/circuit breaker
filters/        # filtros de liquidez/honeypot/slippage
mev/            # envío de transacciones MEV-aware
preloader/      # resolución de pools/rutas/metadata
ranking/        # scoring y lock de ejecución
sizing/         # optimización de tamaño
simulation/     # simulación de rentabilidad
utils/          # logger, multicall, dashboard
scripts/        # deploy
test/           # tests hardhat
```
