/**
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* This file describes the gRPC-streaming. */

import {Duplex, DuplexOptions, Readable, Stream, Writable} from 'stream';

import {
  APICallback,
  CancellableStream,
  GRPCCallResult,
  SimpleCallbackFunction,
} from '../apitypes';
import {RetryOptions, RetryRequestOptions} from '../gax';
import {GoogleError} from '../googleError';
import {streamingRetryRequest} from '../streamingRetryRequest';
import {Status} from '../status';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const duplexify: DuplexifyConstructor = require('duplexify');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const retryRequest = require('retry-request');

// Directly copy over Duplexify interfaces
export interface DuplexifyOptions extends DuplexOptions {
  autoDestroy?: boolean;
  end?: boolean;
}

export interface Duplexify extends Duplex {
  readonly destroyed: boolean;
  setWritable(writable: Writable | false | null): void;
  setReadable(readable: Readable | false | null): void;
}

export interface DuplexifyConstructor {
  obj(
    writable?: Writable | false | null,
    readable?: Readable | false | null,
    options?: DuplexifyOptions
  ): Duplexify;
  new (
    writable?: Writable | false | null,
    readable?: Readable | false | null,
    options?: DuplexifyOptions
  ): Duplexify;
  (
    writable?: Writable | false | null,
    readable?: Readable | false | null,
    options?: DuplexifyOptions
  ): Duplexify;
}

/**
 * The type of gRPC streaming.
 * @enum {number}
 */
export enum StreamType {
  /** Client sends a single request, server streams responses. */
  SERVER_STREAMING = 1,

  /** Client streams requests, server returns a single response. */
  CLIENT_STREAMING = 2,

  /** Both client and server stream objects. */
  BIDI_STREAMING = 3,
}

export class StreamProxy extends duplexify implements GRPCCallResult {
  type: StreamType;
  private _callback: APICallback;
  private _isCancelCalled: boolean;
  stream?: CancellableStream;
  private _responseHasSent: boolean;
  rest?: boolean;
  new_retry?: boolean;
  retried?: number;
  apiCall?: SimpleCallbackFunction;
  argument?: {};
  retryRequestOptions?: RetryRequestOptions;
  errorSaw?: boolean = false;
  prevError?: Error;
  prevDeadline?: number;
  retries?: number = 0;
  inRetryLoop?: boolean = false;
  /**
   * StreamProxy is a proxy to gRPC-streaming method.
   *
   * @private
   * @constructor
   * @param {StreamType} type - the type of gRPC stream.
   * @param {ApiCallback} callback - the callback for further API call.
   */
  constructor(
    type: StreamType,
    callback: APICallback,
    rest?: boolean,
    new_retry?: boolean
  ) {
    super(undefined, undefined, {
      objectMode: true,
      readable: type !== StreamType.CLIENT_STREAMING,
      writable: type !== StreamType.SERVER_STREAMING,
    } as DuplexOptions);
    this.type = type;
    this._callback = callback;
    this._isCancelCalled = false;
    this._responseHasSent = false;
    this.rest = rest;
    this.new_retry = new_retry;
    this.retried = 0;
  }

  cancel() {
    if (this.stream) {
      this.stream.cancel();
    } else {
      this._isCancelCalled = true;
    }
  }

  retry(stream: CancellableStream, retry: RetryOptions) {
    const new_stream = this.apiCall!(
      this.argument!,
      this._callback
    ) as CancellableStream;
    this.stream = new_stream;
    const retryStream = this.forwardClientEvents(new_stream, retry);
    if (retryStream !== undefined) {
      return retryStream;
    }
    return new_stream;
  }

  /**
   * Forward events from an failed user stream to a new user stream that will retries API.
   * @param {Stream} stream - The API request stream.
   * @param {RetryOptions} retry - Configures the exceptions upon which the
   *   function eshould retry, and the parameters to the exponential backoff retry
   *   algorithm.
   */
  forwardClientEvents(
    stream: CancellableStream,
    retry: RetryOptions
  ): CancellableStream | undefined {
    let retryStream = this.stream;
    const delayMult = retry.backoffSettings.retryDelayMultiplier;
    const maxDelay = retry.backoffSettings.maxRetryDelayMillis;
    const timeoutMult = retry.backoffSettings.rpcTimeoutMultiplier;
    const maxTimeout = retry.backoffSettings.maxRpcTimeoutMillis;

    let delay = retry.backoffSettings.initialRetryDelayMillis;
    let timeout = retry.backoffSettings.initialRpcTimeoutMillis;
    let now = new Date();
    let deadline = 0;
    let seenError = false;

    if (retry.backoffSettings.totalTimeoutMillis) {
      deadline = now.getTime() + retry.backoffSettings.totalTimeoutMillis;
    }
    const maxRetries = retry.backoffSettings.maxRetries!;

    if (
      this.prevDeadline! !== undefined &&
      deadline &&
      now.getTime() >= this.prevDeadline
    ) {
      const error = new GoogleError(
        `Total timeout of API exceeded ${retry.backoffSettings.totalTimeoutMillis} milliseconds before any response was received.`
      );
      error.code = Status.DEADLINE_EXCEEDED;
      this.emit('error', error);
      // Without throwing error you get unhandled error since we are returning a new stream
      // There might be a better way to do this
      throw error;
    }

    if (this.retries && this.retries >= maxRetries) {
      const error = new GoogleError(
        'Exceeded maximum number of retries before any ' +
          'response was received'
      );
      error.code = Status.DEADLINE_EXCEEDED;
      this.emit('error', error);
      throw error;
    }

    this.retries!++;
    const eventsToForward = ['data'];
    eventsToForward.forEach(event => {
      stream.on(event, this.emit.bind(this, event));
    });

    stream.on('error', error => {
      seenError = true;
      const e = GoogleError.parseGRPCStatusDetails(error);
      if (
        retry !== undefined &&
        retry.retryCodesOrShouldRetryFn !== undefined
      ) {
        if (
          retry.retryCodesOrShouldRetryFn instanceof Array &&
          retry.retryCodesOrShouldRetryFn.indexOf(e!.code!) < 0
        ) {
          const newError = new GoogleError(
            'Exception occurred in retry method that was ' +
              'not classified as transient'
          );
          newError.code = Status.INVALID_ARGUMENT;
          this.emit('error', newError);
          throw newError;
        }
      } else {
        const toSleep = Math.random() * delay;
        setTimeout(() => {
          now = new Date();
          delay = Math.min(delay * delayMult, maxDelay);
          const timeoutCal = timeout && timeoutMult ? timeout * timeoutMult : 0;
          const rpcTimeout = maxTimeout ? maxTimeout : 0;
          this.prevDeadline = deadline;
          const newDeadline = deadline ? deadline - now.getTime() : 0;
          timeout = Math.min(timeoutCal, rpcTimeout, newDeadline);
        }, toSleep);
      }

      if (maxRetries && deadline!) {
        const error = new GoogleError(
          'Cannot set both totalTimeoutMillis and maxRetries ' +
            'in backoffSettings.'
        );
        error.code = Status.INVALID_ARGUMENT;
        this.emit('error', error);
        throw error;
      } else {
        retryStream = this.retry(stream, retry);
        this.stream = retryStream;
        return;
      }
    });
    stream.on('end', () => {
      if (this.inRetryLoop && seenError === false) {
        this.emit('end');
      }
    });
    return retryStream;
  }

  /**
   * Forward events from an API request stream to the user's stream.
   * @param {Stream} stream - The API request stream.
   * @param {RetryOptions} retry - Configures the exceptions upon which the
   *   function eshould retry, and the parameters to the exponential backoff retry
   *   algorithm.
   */
  forwardEvents(
    stream: CancellableStream,
    retry: RetryOptions
  ): CancellableStream | undefined {
    let retryStream = this.stream;
    const eventsToForward = ['metadata', 'response', 'status'];
    eventsToForward.forEach(event => {
      stream.on(event, this.emit.bind(this, event));
    });
    // gRPC is guaranteed emit the 'status' event but not 'metadata', and 'status' is the last event to emit.
    // Emit the 'response' event if stream has no 'metadata' event.
    // This avoids the stream swallowing the other events, such as 'end'.
    stream.on('status', () => {
      if (!this._responseHasSent) {
        stream.emit('response', {
          code: 200,
          details: '',
          message: 'OK',
        });
      }
    });

    // We also want to supply the status data as 'response' event to support
    // the behavior of google-cloud-node expects.
    // see:
    // https://github.com/GoogleCloudPlatform/google-cloud-node/pull/1775#issuecomment-259141029
    // https://github.com/GoogleCloudPlatform/google-cloud-node/blob/116436fa789d8b0f7fc5100b19b424e3ec63e6bf/packages/common/src/grpc-service.js#L355
    stream.on('metadata', metadata => {
      // Create a response object with succeeds.
      // TODO: unify this logic with the decoration of gRPC response when it's
      // added. see: https://github.com/googleapis/gax-nodejs/issues/65
      stream.emit('response', {
        code: 200,
        details: '',
        message: 'OK',
        metadata,
      });
      this._responseHasSent = true;
    });
    stream.on('error', error => {
      const e = GoogleError.parseGRPCStatusDetails(error);
      if (
        retry !== undefined &&
        retry.retryCodesOrShouldRetryFn !== undefined
      ) {
        if (
          retry.retryCodesOrShouldRetryFn instanceof Array &&
          retry.retryCodesOrShouldRetryFn.indexOf(e!.code!) < 0
        ) {
          const newError = new GoogleError(
            'Exception occurred in retry method that was ' +
              'not classified as transient'
          );
          newError.code = Status.INVALID_ARGUMENT;
          this.emit('error', newError);
          throw error;
        } else {
          this.inRetryLoop = true;
          retryStream = this.retry(stream, retry);
          this.stream = retryStream;
          this.prevError = error;
          this.errorSaw = true;
        }
        GoogleError.parseGRPCStatusDetails(error);
      }
    });

    return retryStream;
  }

  resetStreams(requestStream: CancellableStream) {
    const delayStream = null;

    if (requestStream) {
      requestStream.cancel && requestStream.cancel();

      if (requestStream.destroy) {
        requestStream.destroy();
      } else if (requestStream.end) {
        requestStream.end();
      }
    }
  }

  /**
   * Specifies the target stream.
   * @param {ApiCall} apiCall - the API function to be called.
   * @param {Object} argument - the argument to be passed to the apiCall.
   * @param {RetryOptions} retry - Configures the exceptions upon which the
   *   function eshould retry, and the parameters to the exponential backoff retry
   *   algorithm.
   */
  setStream(
    apiCall: SimpleCallbackFunction,
    argument: {},
    retryRequestOptions: RetryRequestOptions = {},
    retry: RetryOptions
  ) {
    this.apiCall = apiCall;
    this.argument = argument;
    this.retryRequestOptions = retryRequestOptions;

    if (this.type === StreamType.SERVER_STREAMING) {
      if (this.rest) {
        const stream = apiCall(argument, this._callback) as CancellableStream;
        this.stream = stream;
        this.setReadable(stream);
      } else if (this.new_retry) {
        console.log(
          'WARNING: You are using an experimental streamingRetryRequest'
        );
        const retryStream = streamingRetryRequest(
          null,
          {
            objectMode: true,
            request: () => {
              if (this._isCancelCalled) {
                if (this.stream) {
                  this.stream.cancel();
                }
                return;
              }
              const stream = apiCall(
                argument,
                this._callback
              ) as CancellableStream;
              this.stream = stream;
              this.stream = this.forwardEvents(stream, retry);
              return this.stream;
            },
          },
          null
        );

        this.setReadable(retryStream);
      } else {
        const retryStream = retryRequest(null, {
          objectMode: true,
          request: () => {
            if (this._isCancelCalled) {
              if (this.stream) {
                this.stream.cancel();
              }
              return;
            }
            const stream = apiCall(
              argument,
              this._callback
            ) as CancellableStream;
            this.stream = stream;
            this.forwardEvents(stream, retry);
            return stream;
          },
          retries: retryRequestOptions!.retries,
          currentRetryAttempt: retryRequestOptions!.currentRetryAttempt,
          noResponseRetries: retryRequestOptions!.noResponseRetries,
          shouldRetryFn: retryRequestOptions!.shouldRetryFn,
        });
        this.setReadable(retryStream);
      }
      return;
    }

    const stream = apiCall(argument, this._callback) as CancellableStream;
    this.stream = stream;
    this.forwardEvents(stream, retry);

    if (this.type === StreamType.CLIENT_STREAMING) {
      this.setWritable(stream);
    }

    if (this.type === StreamType.BIDI_STREAMING) {
      this.setReadable(stream);
      this.setWritable(stream);
    }

    if (this._isCancelCalled && this.stream) {
      this.stream.cancel();
    }
  }
}
