'use strict';

const {PassThrough} = require('stream');
const extend = require('extend');

const DEFAULTS = {
  /*
    Max # of retries
  */  
    maxRetries: 2,

  /*
    The maximum time to delay in seconds. If retryDelayMultiplier results in a
    delay greater than maxRetryDelay, retries should delay by maxRetryDelay
    seconds instead.
  */
  maxRetryDelayMillis: 64000,

  /*
    The multiplier by which to increase the delay time between the completion of
    failed requests, and the initiation of the subsequent retrying request.
  */
  retryDelayMultiplier: 2,

  /*
    The length of time to keep retrying in seconds. The last sleep period will
    be shortened as necessary, so that the last retry runs at deadline (and not
    considerably beyond it).  The total time starting from when the initial
    request is sent, after which an error will be returned, regardless of the
    retrying attempts made meanwhile.
  */
  totalTimeoutMillis: 600000,

  /*
    The initial delay time, in milliseconds, between the completion of the first 
    failed request and the initiation of the first retrying request.
  */
  initialRetryDelayMillis: 60,

  /*
    Initial timeout parameter to the request.
  */
  initialRpcTimeoutMillis: 60,

  /*
    Maximum timeout in milliseconds for a request. 
    When this value is reached, rpcTimeoutMulitplier will no
    longer be used to increase the timeout.
  */
  maxRpcTimeoutMillis: 60,

  /*
   Multiplier by which to increase timeout parameter in
   between failed requests.
  */
  rpcTimeoutMultiplier: 2,

  /*
    The number of retries that have occured. 
  */
  retries: 0,
};

export function streamingRetryRequest(requestOpts: any= null, opts: any=null, callback: any=null) {
  const streamMode = typeof arguments[arguments.length - 1] !== 'function';

  if (typeof opts === 'function') {
    callback = opts;
  }

  if (typeof opts.request === 'undefined') {
    try {
      // eslint-disable-next-line node/no-unpublished-require
      opts.request = require('request');
    } catch (e) {
      throw new Error('A request library must be provided to retry-request.');
    }
  }

  let numNoResponseAttempts = 0;
  let streamResponseHandled = false;

  let retryStream: any;
  let requestStream: any;
  let delayStream: any;

  let activeRequest: { abort: () => void; };
  const retryRequest = {
    abort: function () {
      if (activeRequest && activeRequest.abort) {
        activeRequest.abort();
      }
    },
  };

  if (streamMode) {
    retryStream = new PassThrough({objectMode: opts.objectMode});
    retryStream.abort = resetStreams;
  }

  makeRequest();

  if (streamMode) {
    return retryStream;
  } else {
    return retryRequest;
  }

  function resetStreams() {
    delayStream = null;

    if (requestStream) {
      requestStream.abort && requestStream.abort();
      requestStream.cancel && requestStream.cancel();

      if (requestStream.destroy) {
        requestStream.destroy();
      } else if (requestStream.end) {
        requestStream.end();
      }
    }
  }

  function makeRequest() {

    if (streamMode) {
      streamResponseHandled = false;

      delayStream = new PassThrough({objectMode: opts.objectMode});
      requestStream = opts.request(requestOpts);

      setImmediate(() => {
        retryStream.emit('request');
      });

      requestStream
        // gRPC via google-cloud-node can emit an `error` as well as a `response`
        // Whichever it emits, we run with-- we can't run with both. That's what
        // is up with the `streamResponseHandled` tracking.
        .on('error', (err: any) => {
          if (streamResponseHandled) {
            return;
          }

          streamResponseHandled = true;
          onResponse(err);
        })
        .on('response', (resp: any, body: any) => {
          if (streamResponseHandled) {
            return;
          }

          streamResponseHandled = true;
          onResponse(null, resp, body);
        })
        .on('complete', retryStream.emit.bind(retryStream, 'complete'));

      requestStream.pipe(delayStream);
    } else {
      activeRequest = opts.request(requestOpts, onResponse);
    }
  }

  function onResponse(err:any , response: any=null, body:any=null) {
    // An error such as DNS resolution.
    if (err) {
      numNoResponseAttempts++;

      if (numNoResponseAttempts <= opts.noResponseRetries) {
        // retryAfterDelay(numNoResponseAttempts);
      } else {
        if (streamMode) {
          retryStream.emit('error', err);
          retryStream.end();
        } else {
          callback(err, response, body);
        }
      }

      return;
    }

    // No more attempts need to be made, just continue on.
    if (streamMode) {
      retryStream.emit('response', response);
      delayStream.pipe(retryStream);
      requestStream.on('error', (err: any) => {
        retryStream.destroy(err);
      });
    } else {
      callback(err, response, body);
    }
  }
}

