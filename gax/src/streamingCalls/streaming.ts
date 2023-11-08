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
  RequestType,
  SimpleCallbackFunction,
} from '../apitypes';
import {RetryOptions, RetryRequestOptions} from '../gax';
import {GoogleError} from '../googleError';
import {streamingRetryRequest} from '../streamingRetryRequest';
import {Status} from '../status';
import {warn} from '../warnings';

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
  apiCall?: SimpleCallbackFunction;
  argument?: {};
  prevDeadline?: number;
  retries?: number = 0;
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
  }

  cancel() {
    if (this.stream) {
      this.stream.cancel();
    } else {
      this._isCancelCalled = true;
    }
  }

  retry(stream: CancellableStream, retry: RetryOptions) {
    let retryArgument = this.argument! as unknown as RequestType;

    if (
      typeof retry.getResumptionRequestFn! === 'function' &&
      retry.getResumptionRequestFn(retryArgument)
    ) {
      retryArgument = retry.getResumptionRequestFn(retryArgument);
    }

    this.resetStreams(stream);

    const new_stream = this.apiCall!(
      retryArgument,
      this._callback
    ) as CancellableStream;
    this.stream = new_stream;

    this.streamHandoffHelper(new_stream, retry);
    return new_stream;
  }

  /**
   * Helper function to handle total timeout + max retry check for server streaming retries
   * @param {number} deadline - the current retry deadline
   * @param {number} maxRetries - maximum total number of retries
   * @param {number} totalTimeoutMillis - total timeout in milliseconds
   */
  timeoutAndMaxRetryCheck(
    deadline: number,
    maxRetries: number,
    totalTimeoutMillis: number
  ): void {
    const now = new Date();

    if (
      this.prevDeadline! !== undefined &&
      deadline &&
      now.getTime() >= this.prevDeadline
    ) {
      console.log("176")
      const error = new GoogleError(
        `Total timeout of API exceeded ${totalTimeoutMillis} milliseconds before any response was received.`
      );
      error.code = Status.DEADLINE_EXCEEDED;
      this.emit('error', error)
      this.destroy();
      // Without throwing error you get unhandled error since we are returning a new stream
      // There might be a better way to do this
      throw error;
    }
    console.log("BEFORE MAX RETRIES", this.retries, maxRetries)

    if (this.retries && this.retries >= maxRetries) {
      console.log("MAX RETRIES", this.retries, maxRetries)
      const error = new GoogleError(
        'Exceeded maximum number of retries before any ' +
          'response was received'
      );
      error.code = Status.DEADLINE_EXCEEDED;
      console.log('before emit')
      this.emit('error', error)
      console.log('before destroy')
      this.destroy();
      throw error;
    }
  }

  /**
   * Error handler for server streaming retries
   * @param {CancellableStream} stream - the stream being retried
   * @param {RetryOptions} retry - Configures the exceptions upon which the
   *   function should retry, and the parameters to the exponential backoff retry
   *   algorithm.
   * @param {Error} error - error to handle
   */
  streamHandoffErrorHandler(
    stream: CancellableStream,
    retry: RetryOptions,
    error: Error
  ): void {
    let retryStream = this.stream;
    const delayMult = retry.backoffSettings.retryDelayMultiplier;
    const maxDelay = retry.backoffSettings.maxRetryDelayMillis;
    const timeoutMult = retry.backoffSettings.rpcTimeoutMultiplier;
    const maxTimeout = retry.backoffSettings.maxRpcTimeoutMillis;

    let delay = retry.backoffSettings.initialRetryDelayMillis;
    let timeout = retry.backoffSettings.initialRpcTimeoutMillis;
    let now = new Date();
    let deadline = 0;

    if (retry.backoffSettings.totalTimeoutMillis) {
      deadline = now.getTime() + retry.backoffSettings.totalTimeoutMillis;
    }
    const maxRetries = retry.backoffSettings.maxRetries!;
    try{
      this.timeoutAndMaxRetryCheck(
          deadline,
          maxRetries,
          retry.backoffSettings.totalTimeoutMillis!
        );
      }catch(error){
        // console.log("CAUGHT")

        // this.emit('error', error)
        // console.log("after emit")
        // this.destroy(error)
        console.log("240")
        return
      }

    console.log("RIGHT BEFORE INCREASE", this.retries)
    this.retries!++;
    const e = GoogleError.parseGRPCStatusDetails(error);
    console.log("after parse afte rincrease")
    let shouldRetry = this.defaultShouldRetry(e!, retry);
    if (retry.shouldRetryFn) {
      console.log("theres a shoudlretry function")
      shouldRetry = retry.shouldRetryFn(e!);
    }

    if (shouldRetry) {
      console.log("shouldRetry249")
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
    } else {
      console.log("else 261")
      e.note =
        'Exception occurred in retry method that was ' +
        'not classified as transient';
      this.emit('error', e)
      this.destroy();
      return;
    }
    console.log("276")
    retryStream = this.retry(stream, retry);
    this.stream = retryStream;
    return;
  }

  /**
   * Used during server streaming retries to handle
   * event forwarding, errors, and/or stream closure
   * @param {CancellableStream} stream - the stream that we're doing the retry on
   * @param {RetryOptions} retry - Configures the exceptions upon which the
   *   function should retry, and the parameters to the exponential backoff retry
   *   algorithm.
   */
  streamHandoffHelper(stream: CancellableStream, retry: RetryOptions): void {
    let enteredError = false;
    const eventsToForward = ['metadata', 'response', 'status', 'data'];
    eventsToForward.forEach(event => {
      stream.on(event, this.emit.bind(this, event));
    });

    stream.on('error', error => {
      enteredError = true;
      this.streamHandoffErrorHandler(stream, retry, error);
    });

    stream.on('end', () => {
      if (!enteredError) {
        enteredError = true;
        this.emit('end');
        this.cancel();
      }
    });
  }

  /**
   * Forward events from an API request stream to the user's stream.
   * @param {Stream} stream - The API request stream.
   * @param {RetryOptions} retry - Configures the exceptions upon which the
   *   function should retry, and the parameters to the exponential backoff retry
   *   algorithm.
   */

  forwardEvents(stream: Stream) {
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
      GoogleError.parseGRPCStatusDetails(error);
    });
  }

  defaultShouldRetry(error: GoogleError, retry: RetryOptions) {
    if (
      retry.retryCodes.length > 0 &&
      retry.retryCodes.indexOf(error!.code!) < 0
    ) {
      console.log("should not retry")
      return false;
    }
    return true;
  }

  /**
   * Forward events from an API request stream to the user's stream.
   * @param {Stream} stream - The API request stream.
   * @param {RetryOptions} retry - Configures the exceptions upon which the
   *   function eshould retry, and the parameters to the exponential backoff retry
   *   algorithm.
   */
  forwardEventsNewImplementation(
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
      //@ts-ignore
      console.log("on error", error.code)
      const timeout = retry.backoffSettings.totalTimeoutMillis;
      const maxRetries = retry.backoffSettings.maxRetries!;
      if ((maxRetries && maxRetries > 0) || (timeout && timeout > 0)) {
        const e = GoogleError.parseGRPCStatusDetails(error);
        let shouldRetry = this.defaultShouldRetry(e!, retry);
        if (retry.shouldRetryFn) {
          shouldRetry = retry.shouldRetryFn(e!);
        }

        if (shouldRetry) {
          console.log("shouldretry")
          console.log(maxRetries, timeout)
          if (maxRetries && timeout!) {
            console.log("this one")
            const newError = new GoogleError(
              'Cannot set both totalTimeoutMillis and maxRetries ' +
                'in backoffSettings.'
            );
            newError.code = Status.INVALID_ARGUMENT;
            this.emit('error', newError)
            this.destroy();
            return; //end chunk
          } else {
            console.log("441")
            // On subsequent retries, this will be increased in the streamHandoffErrorHandler
            // but if we don't increment by one here we will have an off by one
            this.retries!++; //TODO if we do >= do we still need this?
            retryStream = this.retry(stream, retry);
            console.log('455')
            this.stream = retryStream;
            return retryStream;
          }
        } else {
          console.log("transient spot")
          const e = GoogleError.parseGRPCStatusDetails(error);
          e.note =
            'Exception occurred in retry method that was ' +
            'not classified as transient';
          this.destroy(error);
          return; // end chunk
        }
      } else {
        console.log("else")
        return GoogleError.parseGRPCStatusDetails(error);
      }
    });
    return retryStream;
  }

  resetStreams(requestStream: CancellableStream) {
    if (requestStream) {
      requestStream.cancel && requestStream.cancel();

      if (requestStream.destroy) {
        requestStream.destroy();
      } else if (requestStream.end) {
        requestStream.end(); //TODO supposedly untested
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

    if (this.type === StreamType.SERVER_STREAMING) {
      if (this.rest) {
        const stream = apiCall(argument, this._callback) as CancellableStream;
        this.stream = stream;
        this.setReadable(stream);
      } else if (this.new_retry) {
        warn(
          'gax_server_streaming_retries',
          'You are using the new experimental gax native server streaming retry implementation',
          'ExperimentalWarning'
        );
        const retryStream = streamingRetryRequest(
          null,
          {
            objectMode: true,
            request: () => {
              if (this._isCancelCalled) { //TODO(coleleah): tested?
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
              console.log("calling new forward")
              this.stream = this.forwardEventsNewImplementation(stream, retry);
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
            this.forwardEvents(stream);
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
    this.forwardEvents(stream);

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
