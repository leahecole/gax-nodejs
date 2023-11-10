// Copyright 2023 Google LLC

// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at

//     https://www.apache.org/licenses/LICENSE-2.0

// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const {PassThrough} = require('stream');
import {GoogleError} from './googleError';
import {ResponseType} from './apitypes';


const DEFAULTS = {
  /*
    Max # of retries
  */
  maxRetries: 2,

  

};
// In retry-request, you could pass parameters to request using the requestOpts parameter
// when we called retry-request from gax, we always passed null
// passing null here removes an unnecessary parameter from this implementation
const requestOps = null;
const objectMode = true; // we don't support objectMode being false

interface streamingRetryRequestOptions{
  request?: Function//TODO update,
  maxRetries?: number //TODO update
}
/**
 * Localized adaptation derived from retry-request
 * @param opts - corresponds to https://github.com/googleapis/retry-request#opts-optional
 * @returns
 */
export function streamingRetryRequest(opts: streamingRetryRequestOptions) {
  console.log("opts", opts) 
  console.log(typeof opts!.request)

  // TODO - can we remove this default maxRetries
  // and unify with the actual max retries that may be passed?
  opts = Object.assign({}, DEFAULTS, opts);
  console.log("opts after", opts)
  console.log(typeof opts.request)

  
  if (opts.request === undefined) {
    try {
      // eslint-disable-next-line node/no-unpublished-require
      opts.request = require('request');
    } catch (e) {
      throw new Error('A request library must be provided to retry-request.');
    }
  }

  let numNoResponseAttempts = 0;
  let streamResponseHandled = false;

  let requestStream: any;
  let delayStream: any;

  const retryStream = new PassThrough({objectMode: objectMode});

  makeRequest();
  return retryStream;

  function makeRequest() {
    streamResponseHandled = false;

    delayStream = new PassThrough({objectMode: objectMode});
    requestStream = opts.request!(requestOps);

    requestStream
      // gRPC via google-cloud-node can emit an `error` as well as a `response`
      // Whichever it emits, we run with-- we can't run with both. That's what
      // is up with the `streamResponseHandled` tracking.
      .on('error', (err: GoogleError) => {
        if (streamResponseHandled) {
          return;
        }
        streamResponseHandled = true;
        onResponse(err);
      })
      .on('response', (resp: ResponseType) => {
        console.log("respbody", resp)
        if (streamResponseHandled) {
          return;
        }

        streamResponseHandled = true;
        onResponse(null, resp);
      })

    requestStream.pipe(delayStream);
  }

  function onResponse(err: GoogleError | null, response: ResponseType = null) {
    console.log("ONRESPONSE", err, response)
    // An error such as DNS resolution.
    //TODO validate
    if (err) {
      console.log("onresponseerr")
      numNoResponseAttempts++;

      //TOOD 
      if (numNoResponseAttempts <= opts.maxRetries!) {
        console.log("doin a rerequest??")
        makeRequest();
      } else {
        retryStream.emit('error', err);
      }

      return;
    }

    // No more attempts need to be made, just continue on.
    retryStream.emit('response', response);
    delayStream.pipe(retryStream);
    requestStream.on('error', (err: GoogleError) => {
      console.log("before RR destroy", err)
      retryStream.destroy(err);
    });
  }
}
