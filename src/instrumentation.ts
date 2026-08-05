// OpenTelemetry bootstrap. Preloaded via NODE_OPTIONS (see chart/templates/
// deployment.yaml) BEFORE the app requires fastify/pg/pino, so the SDK can
// monkey-patch them - which is also why the backend is compiled to CommonJS
// (require-based patching). This runs ONLY on the `main` branch: the chart sets
// NODE_OPTIONS=--require /app/build/instrumentation.js only when otel.endpoint is
// non-empty, so on every other branch the SDK never loads.
//
// We build the instrumentation list ourselves instead of using
// @opentelemetry/auto-instrumentations-node/register because that meta-package
// does NOT ship a Fastify instrumentation. So: the standard auto set (http/pg/
// pino/runtime metrics/...) PLUS @opentelemetry/instrumentation-fastify, which
// adds Fastify request-handler/route spans on top of the raw http server span.
//
// Exporters, endpoint, protocol and service name all come from the OTEL_* env
// vars the chart sets (OTEL_EXPORTER_OTLP_ENDPOINT / _PROTOCOL, OTEL_SERVICE_NAME,
// OTEL_{TRACES,METRICS,LOGS}_EXPORTER=otlp) - NodeSDK auto-configures traces,
// metrics AND logs from them, so there's nothing to wire here.
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { FastifyInstrumentation } from "@opentelemetry/instrumentation-fastify";

const sdk = new NodeSDK({
  instrumentations: [
    getNodeAutoInstrumentations({
      // fs instrumentation is extremely noisy (a span per file op); the register
      // hook disables it by default too, so match that.
      "@opentelemetry/instrumentation-fs": { enabled: false },
    }),
    new FastifyInstrumentation(),
  ],
});

sdk.start();

// Flush spans/metrics/logs on shutdown so nothing in-flight is dropped.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void sdk.shutdown().finally(() => process.exit(0));
  });
}
