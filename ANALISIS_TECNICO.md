# Estado técnico y readiness (Base Arbitrage Engine V2)

Fecha: 2026-04-01

## Resultado

- **Estado para fase de pruebas (fork/paper): LISTO**, con hardening aplicado en código y suite alineada a V2.
- **Estado para live con capital real: NO listo aún** hasta completar prerrequisitos operativos y validación extendida (ver sección final).

## Cambios aplicados (hardening)

1. **Alineación contrato/deploy/tests a V2**
   - Deploy actualizado para `FlashLoanArbitrageV2`.
   - Tests actualizados a ABI/firmas/reverts V2 (`setConfig`, `rescue`, `requestFlashLoan` con deadline + opportunityId).

2. **Circuit breaker integrado al flujo de ejecución**
   - `Scanner` ahora consulta el estado del circuit breaker antes de evaluar/ejecutar.
   - `PipelineRunner` reporta éxitos y fallos de ejecución al `Failsafe`.
   - `index.js` conecta explícitamente `failsafe` al scanner/pipeline.

3. **Deadline corregido**
   - Cálculo de deadline simplificado a tiempo unix + TTL (sin mezclar block number con timestamp).

4. **Mejora V3 en preload/fetch inicial**
   - Se hidrata `liquidity` de pools V3 en el fetch inicial.
   - En eventos `Swap` también se refresca `liquidity` junto con precio.

5. **Mejora de matching en hot-path**
   - Índice `routesByPool` precomputado para lookup O(k) por pool actualizado.

6. **Validación de configuración fortalecida**
   - Validaciones de formato mínimo para `TOKEN_PAIRS` y `DEX_CONFIGS`.
   - Errores explícitos para entradas inválidas o vacías.

7. **Reducción parcial de riesgo de precisión numérica**
   - Se reemplazaron conversiones directas peligrosas por conversiones basadas en `formatUnits` en partes críticas de scanner/slippage.

## Alcance de “listo para pruebas”

A partir de estos cambios, el código queda apto para iniciar:

- Pruebas funcionales sobre fork local de Base.
- Pruebas de paper trading con monitoreo de decisiones.
- Validación de regresión de rutas V2/V3 y condiciones de failover.

## Qué falta para pasar a live (obligatorio)

1. **Batería de pruebas completa en CI/CD**
   - Unit + integración + escenarios de estrés (latencia, reconexión WS, relayer caído).

2. **Modelado V3 de alta fidelidad**
   - Integrar cotización exacta por QuoterV2/ticks para sizing final en producción.

3. **Controles de riesgo en runtime**
   - Límites por sesión/día, stop-loss por drawdown, y “kill switch” remoto.

4. **Runbook y operación**
   - Alertas, on-call, rollback, rotación de llaves, manejo de incidentes.

5. **Validación económica en paper**
   - Mínimo N días de paper trading con métricas de fill-rate, slippage real vs estimado, y PnL neto tras gas.

6. **Auditoría de seguridad previa**
   - Revisión externa del contrato + engine de ejecución antes de usar capital significativo.
