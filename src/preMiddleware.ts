/**
 * Restify middleware.
 */

import {exposeRoute} from './exposeRoute';
import {PathLimit} from './PathLimit';

import * as Debug from 'debug';
import * as onFinished from 'on-finished';
import * as client from 'prom-client';
import * as restify from 'restify';

const debug: Debug.IDebugger = Debug('restify-prom-bundle');

let assign: Function;

if (!Object.assign) {
  /* tslint:disable: no-require-imports no-var-requires */
  assign = require('object-assign');
  /* tslint:enable: no-require-imports no-var-requires */
} else {
  assign = Object.assign;
}

export interface IPreMiddlewareConfig {
  /**
   * Exposed route.
   */
  route?: string | false;
  /**
   * Excluded paths.
   */
  exclude?: string | string[] | RegExp | Function;
  /**
   * Prom-client blacklist.
   */
  promBlacklist?: string[];
  /**
   * How often (ms) should prom-client fire default probes.
   */
  promDefaultDelay?: number;
}

/**
 * Default configuration.
 */
const defaultConfig: IPreMiddlewareConfig = {
  route: '/metrics',
  maxPathsToCount: 100,
  promDefaultDelay: 1000,
  promBlacklist: [],
};

/**
 * Bundle metrics.
 */
interface IBundleMetrics {
  requestHistogram?: client.Histogram;
  requestCounter?: client.Counter;
}

/**
 * Cache for shouldMeasure exclusion test.
 */
/* tslint:disable: no-any */
let shouldMeasureExcludedCache: any;
/* tslint:enable: no-any */

/**
 * Tells if a path should be measured (not excluded).
 */
const shouldMeasure = (path: string, config: IPreMiddlewareConfig): boolean => {
  let isExcluded: boolean = false;

  if (config.exclude) {
    debug('-> Should we measure %s (%o)?', path, config.exclude);
    debug('%o', shouldMeasureExcludedCache);
    if (shouldMeasureExcludedCache.hasOwnProperty(path)) {
      isExcluded = shouldMeasureExcludedCache[path];
      debug(`${isExcluded ? 'no' : 'yes'} (cached)`);
    } else {
      if (Array.isArray(config.exclude) && ((<string[]>config.exclude).indexOf(path) !== -1)) {
        isExcluded = true;
        debug('No (in exclude list)');
      } else if ((config.exclude instanceof RegExp) && (<RegExp>config.exclude).test(path)) {
        isExcluded = true;
        debug('No (matches exclude regex)');
      } else if ((typeof(config.exclude) === 'function') && !!(<Function>config.exclude)(path)) {
        isExcluded = true;
        debug('No (function returned true)');
      }
      shouldMeasureExcludedCache[path] = isExcluded;
    }
    if (!isExcluded) {
      debug('Yes');
    }
  }
  return !isExcluded;
};

/**
 * Checks if config object is valid and add default values.
 */
const checkConfig = (userConfig?: IPreMiddlewareConfig): IPreMiddlewareConfig => {
  let config: IPreMiddlewareConfig;

  if ((typeof userConfig !== 'object') && (userConfig !== undefined)) {
    throw new TypeError('Invalid second argument for restify-prom-bundle.middleware()');
  }
  config = assign(
    {},
    defaultConfig,
    userConfig || {}
  );
  if (
    (config.route !== false) &&
    ((typeof config.route !== 'string') || !config.route)
  ) {
    throw new TypeError('`route` option for restify-prom-bundle.middleware() must be a non empty string or false');
  }
  if (typeof config.exclude === 'string') {
    config.exclude = [ <string>config.exclude ];
  }
  if (
    config.exclude && (
      !Array.isArray(config.exclude) &&
      !(config.exclude instanceof RegExp) &&
      !(typeof(config.exclude) === 'function')
    )
  ) {
    throw new TypeError(
      '`exclude` option for restify-prom-bundle.middleware() must be string | string[] | RegExp | Function'
    );
  }
  if (!Array.isArray(config.promBlacklist)) {
    throw new TypeError('`promBlacklist` option for restify-prom-bundle.middleware() must be an array');
  }
  if ((typeof config.promDefaultDelay !== 'number') || config.promDefaultDelay < 1000) {
    throw new TypeError('`promDefaultDelay` option for restify-prom-bundle.middleware() must be number >= 1000');
  }

  debug('Final config : %o', config);
  return config;
};

/**
 * Initialize metrics.
 */
const initMetrics = (config: IPreMiddlewareConfig): IBundleMetrics => {
  const metrics: IBundleMetrics = {};
  const labels: Array = ['path', 'status_code', 'method'];

  metrics.requestHistogram = new client.Histogram(
    'http_request_duration_miliseconds',
    'Response time in seconds for each request',
    labels,
    {
      buckets: [0.003, 0.03, 0.1, 0.3, 1.5, 10],
    },
  );
  metrics.requestCounter = new client.Counter(
    'http_requests_total',
    'Total number of requests',
    labels,
  );
  return metrics;
};

/**
 * Create restify's pre-middleware.
 */
export const preMiddleware =
  (server: restify.Server, userConfig?: IPreMiddlewareConfig): restify.RequestHandler => {
    let pathLimiter: PathLimit;
    let config: IPreMiddlewareConfig;
    let metrics: IBundleMetrics;

    debug('Initializing pre-middleware');
    shouldMeasureExcludedCache = {};
    if ((typeof(server) !== 'object') || !server.router || !server.pre) {
      throw new TypeError(
        'restify-prom-bundle.middleware() must take a restify server instance as first argument'
      );
    }
    config = checkConfig(userConfig);
    debug(
      'Blacklisting prom-client default metrics with %sms delay : %o',
      config.promBlacklist,
      config.promDefaultDelay
    );
    client.defaultMetrics(config.promBlacklist, config.promDefaultDelay);
    pathLimiter = new PathLimit(config.maxPathsToCount);
    // We register the route on pre now to bypass router and avoid middlewares.
    if (config.route) {
      server.pre(exposeRoute(config.route));
    }
    metrics = initMetrics(config);
    /* tslint:disable: no-function-expression */
    return function (req: restify.Request, res: restify.Response, next: Function): void {
      /* tslint:enable: no-function-expression */
      let debugStartTime: [number, number];

      if (debug.enabled) {
        debugStartTime = process.hrtime();
        debug('Starting pre-middleware run, searching route for request');
      }
      server.router.find(req, res, (routeFindError: Error, route: restify.Route): void => {
        debug('Searching route result: %o', {error: routeFindError && routeFindError.message});
        let path: string = req.path();

        if (!routeFindError) {
          /* tslint:disable: no-any */
          const routePath = route.spec.path || (<any>route).spec.url;
          /* tslint:enable: no-any */

          path = (routePath instanceof RegExp) ?
            `RegExp(${routePath})` :
              routePath.toString();
        }
        debug('Using path: %s', path);
        // If path is not excluded
        if (shouldMeasure(path, config)) {
          // http_request_duration_miliseconds if enabled and restify-defined route
          if (metrics.requestHistogram && !routeFindError) {
            debug('Starting timer for %s %s', req.method, path);
            const timerEnd: Function = metrics.requestHistogram.startTimer({
              path,
              method: req.method,
            });
            onFinished(res, (err2: Error, res2: restify.Response) => {
              const labels: client.labelValues = {
                status_code: (res2 && res2.statusCode) ? res2.statusCode : 0,
              };
              debug('End timer for %s %s', req.method, path);
              timerEnd(labels);
            });
          }
          // http_request_count if enabled and url limit not reached
          if (metrics.requestCounte && pathLimiter.registerPath(path)) {
            onFinished(res, (err2: Error, res2: restify.Response) => {
              const labels: client.labelValues = {
                path,
                method: req.method,
                status_code: (res2 && res2.statusCode) ? res2.statusCode : 0,
              };
              debug('Incrementing http_request_duration_miliseconds code %o', labels);
              metrics.requestCounter.inc(labels);
            });
          }
        }
        if (debug.enabled) {
          const result: [number, number] = process.hrtime(debugStartTime);
          debug(
            'Finished pre-middleware run, took %dms',
            (result[0] * 1000) + Math.round(result[1] / 1000000)
          );
        }
        next();
      });
    };
  };
