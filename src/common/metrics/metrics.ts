/**
 * @fileoverview Optional Prometheus metrics. Off unless METRICS_PORT is set; then it collects the
 * default process metrics plus an HTTP request-duration histogram, and serves them from a bare
 * HTTP server on METRICS_PORT — a separate port, so /metrics is never reachable on the public one.
 * @module src/common/metrics/metrics
 * @author Prince Jadiya
 */

import http from 'http';
import type { NextFunction, Request, Response } from 'express';
import { collectDefaultMetrics, Histogram, register } from 'prom-client';

/**
 * Start the metrics server when `METRICS_PORT` is a positive number.
 *
 * @returns Express middleware that records request durations, or null when metrics are off.
 */
export function setupMetrics(
  metricsPort: string | undefined,
): ((req: Request, res: Response, next: NextFunction) => void) | null {
  const port = Number(metricsPort);
  if (!(port > 0)) return null;

  collectDefaultMetrics();
  const duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'],
  });

  http
    .createServer((req, res) => {
      if (req.method !== 'GET' || req.url !== '/metrics') {
        res.statusCode = 404;
        res.end();
        return;
      }
      register.metrics().then(
        (body) => {
          res.setHeader('Content-Type', register.contentType);
          res.end(body);
        },
        (err: Error) => {
          res.statusCode = 500;
          res.end(err.message);
        },
      );
    })
    .listen(port)
    // Never keeps the process alive: on SIGTERM the Nest shutdown hooks finish and Node must
    // exit, otherwise Kubernetes waits out the whole grace period and SIGKILLs the pod.
    .unref();

  return (req, res, next) => {
    const end = duration.startTimer();
    res.on('finish', () => {
      // The matched route pattern (it includes the `/api/v1` global prefix), never the raw URL:
      // ids in paths would make label cardinality unbounded.
      const route = (req.route as { path?: string } | undefined)?.path;
      end({
        method: req.method,
        route: route ?? 'unmatched',
        status_code: res.statusCode,
      });
    });
    next();
  };
}
