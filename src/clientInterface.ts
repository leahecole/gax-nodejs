// Copyright 2020 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// ** This file is automatically generated by gapic-generator-typescript. **
// ** https://github.com/googleapis/gapic-generator-typescript **
// ** All changes to this file may be overwritten. **

import {GrpcClientOptions, ClientStubOptions} from './grpc';
import * as gax from './gax';
import {GoogleAuthOptions} from 'google-auth-library';
import {
  BundleDescriptor,
  LongrunningDescriptor,
  PageDescriptor,
  StreamDescriptor,
} from './descriptor';
import * as longrunning from './longRunningCalls/longrunning';
import * as operationProtos from '../protos/operations';

export interface ClientOptions
  extends GrpcClientOptions,
    GoogleAuthOptions,
    ClientStubOptions {
  libName?: string;
  libVersion?: string;
  clientConfig?: gax.ClientConfig;
  fallback?: boolean | 'rest' | 'proto';
  apiEndpoint?: string;
  newRetry?: boolean;
}

export interface Descriptors {
  page: {[name: string]: PageDescriptor};
  stream: {[name: string]: StreamDescriptor};
  longrunning: {[name: string]: LongrunningDescriptor};
  batching?: {[name: string]: BundleDescriptor};
}

export interface Callback<
  ResponseObject,
  NextRequestObject,
  RawResponseObject
> {
  (
    err: Error | null | undefined,
    value?: ResponseObject | null,
    nextRequest?: NextRequestObject,
    rawResponse?: RawResponseObject
  ): void;
}

export interface LROperation<ResultType, MetadataType>
  extends longrunning.Operation {
  promise(): Promise<
    [ResultType, MetadataType, operationProtos.google.longrunning.Operation]
  >;
}

export interface PaginationCallback<
  RequestObject,
  ResponseObject,
  ResponseType
> {
  (
    err: Error | null,
    values?: ResponseType[],
    nextPageRequest?: RequestObject,
    rawResponse?: ResponseObject
  ): void;
}

export interface PaginationResponse<
  RequestObject,
  ResponseObject,
  ResponseType
> {
  values?: ResponseType[];
  nextPageRequest?: RequestObject;
  rawResponse?: ResponseObject;
}
