/**
 * Copyright 2022 Google LLC
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

'use strict';
import { EchoClient, SequenceServiceClient,protos } from 'showcase-echo-client';
import {ShowcaseServer} from 'showcase-server';


import * as assert from 'assert';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { protobuf, grpc, GoogleError, GoogleAuth, Status,createBackoffSettings, CallOptions, RetryOptions} from 'google-gax';
import stream = require('stream');


async function testShowcase() {
  const grpcClientOpts = {
    grpc,
    sslCreds: grpc.credentials.createInsecure(),
  };

  const grpcClientOptsWithNewRetry = {
    grpc,
    sslCreds: grpc.credentials.createInsecure(),
    newRetry: true
  };

  const fakeGoogleAuth = {
    getClient: async () => {
      return {
        getRequestHeaders: async () => {
          return {
            Authorization: 'Bearer zzzz',
          };
        },
      };
    },
  } as unknown as GoogleAuth;

  const fallbackClientOpts = {
    fallback: true,
    protocol: 'http',
    port: 1337,
    auth: fakeGoogleAuth,
  };

  const restClientOpts = {
    fallback: 'rest' as const,
    protocol: 'http',
    port: 7469,
    auth: fakeGoogleAuth,
  };
  
  // const grpcClient = new EchoClient(grpcClientOpts);
  // const grpcSequenceClient = new SequenceServiceClient(grpcClientOpts);

  // const grpcClientWithNewRetry = new EchoClient(grpcClientOptsWithNewRetry);
  const grpcSequenceClientWithNewRetry = new SequenceServiceClient(grpcClientOptsWithNewRetry);

  // const fallbackClient = new EchoClient(fallbackClientOpts);
  // const restClient = new EchoClient(restClientOpts);

  // assuming gRPC server is started locally
  // await testCreateSequence(grpcSequenceClient);
  await testStreaming(grpcSequenceClientWithNewRetry);
  // // await streamingNotRetryEligible(grpcSequenceClient);

  // await testEcho(grpcClient);
  // await testEchoError(grpcClient);
  // await testExpand(grpcClient);
  // await testPagedExpand(grpcClient);
  // await testPagedExpandAsync(grpcClient);
  // await testCollect(grpcClient);
  // await testChat(grpcClient);
  // await testWait(grpcClient);

  // await testEcho(fallbackClient);
  // await testEchoError(fallbackClient);
  // await testExpandThrows(fallbackClient); // fallback does not support server streaming
  // await testPagedExpand(fallbackClient);
  // await testPagedExpandAsync(fallbackClient);
  // await testCollectThrows(fallbackClient); // fallback does not support client streaming
  // await testChatThrows(fallbackClient); // fallback does not support bidi streaming
  // await testWait(fallbackClient);

  // await testEcho(restClient);
  // await testExpand(restClient); // REGAPIC supports server streaming
  // await testPagedExpand(restClient);
  // await testPagedExpandAsync(restClient);
  // await testCollectThrows(restClient); // REGAPIC does not support client streaming
  // await testChatThrows(restClient); // REGAPIC does not support bidi streaming
  // await testWait(restClient);

  // // Testing with newRetry being true 
  // await testCreateSequence(grpcSequenceClientWithNewRetry);
  // await streamingNotRetryEligible(grpcSequenceClientWithNewRetry);
  
  // await testEcho(grpcClientWithNewRetry);
  // await testEchoError(grpcClientWithNewRetry);
  // await testExpand(grpcClientWithNewRetry);
  // await testPagedExpand(grpcClientWithNewRetry);
  // await testPagedExpandAsync(grpcClientWithNewRetry);
  // await testCollect(grpcClientWithNewRetry);
  // await testChat(grpcClientWithNewRetry);
  // await testWait(grpcClientWithNewRetry);
}

function getStreamingSequenceRequest(){
  const request = new protos.google.showcase.v1beta1.CreateStreamingSequenceRequest()

  let firstDelay = new protos.google.protobuf.Duration();
  firstDelay.nanos=150;

  let firstStatus = new protos.google.rpc.Status();
  firstStatus.code=Status.UNAVAILABLE;
  firstStatus.message="UNAVAILABLE";

  let firstResponse = new protos.google.showcase.v1beta1.StreamingSequence.Response();
  firstResponse.delay=firstDelay;
  firstResponse.status=firstStatus;

  // The Index you want the stream to fail or send the status 
  // This  should be index + 1 so if you want to send status at index 0 
  // you would provide firstResponse.responseIndex=1

  firstResponse.responseIndex=1;
  
  // let secondDelay = new protos.google.protobuf.Duration();
  // secondDelay.nanos=150;

  // let secondStatus = new protos.google.rpc.Status();
  // secondStatus.code=Status.DEADLINE_EXCEEDED;
  // secondStatus.message="DEADLINE_EXCEEDED";

  // let secondResponse = new protos.google.showcase.v1beta1.StreamingSequence.Response();
  // secondResponse.delay=secondDelay;
  // secondResponse.status=secondStatus;
  // secondResponse.responseIndex=2

  let thirdDelay = new protos.google.protobuf.Duration();
  thirdDelay.nanos=500000;

  let thirdStatus = new protos.google.rpc.Status();
  thirdStatus.code=Status.OK;
  thirdStatus.message="OK";

  let thirdResponse = new protos.google.showcase.v1beta1.StreamingSequence.Response();
  thirdResponse.delay=thirdDelay;
  thirdResponse.status=thirdStatus;
  thirdResponse.responseIndex=11;

  let streamingSequence = new protos.google.showcase.v1beta1.StreamingSequence()
  streamingSequence.responses = [firstResponse,thirdResponse];
  streamingSequence.content = "This is testing the brand new and shiny StreamingSequence server 3";
  request.streamingSequence = streamingSequence

  return request
}

async function testEcho(client: EchoClient) {
    const backoffSettings = createBackoffSettings(
      100,
      1.2,
      1000,
      null,
      1.5,
      3000,
      45000
    );

  const retryOptions = new RetryOptions([4],backoffSettings)

  let settings = {
    retry:retryOptions,
  }

  const request = {
    content: 'test',
    error:{
      code:4,
      message:"deadline"
    }
  };
  const timer = setTimeout(() => {
    throw new Error('End-to-end testEcho method fails with timeout');
  }, 12000);
  const [response] = await client.echo(request,settings);
  clearTimeout(timer);
  assert.deepStrictEqual(request.content, response.content);
}



async function testCreateSequence(client: SequenceServiceClient) {
  client.initialize()
  const request = getStreamingSequenceRequest();
  // Run request

  const response = await client.createStreamingSequence(request);
  const sequence = response[0]
  let reports: any[] = []

  let attemptRequest = new protos.google.showcase.v1beta1.AttemptStreamingSequenceRequest()
  attemptRequest.name = sequence.name!

  // Inspired by https://pgarciacamou.medium.com/javascript-recursive-re-try-catch-a761ca0c0533
  async function multipleSequenceAttempts(numberOfAttempts = 1): Promise<stream> {
      const attemptStream = await client.attemptStreamingSequence(attemptRequest)
      attemptStream.on('error',async function(e: any) {
        if (numberOfAttempts > 0) {
          return await multipleSequenceAttempts(numberOfAttempts - 1)
        } else {
          throw e
        }
      })

      attemptStream.on('end',async function() {
        const sequnceReport = sequence.name! + "/streamingSequenceReport"
    
        const reportRequest = new protos.google.showcase.v1beta1.GetStreamingSequenceReportRequest()
        reportRequest.name = sequnceReport
      
        const report = await client.getStreamingSequenceReport(reportRequest);

        assert.equal(report[0].attempts![0].contentSent,"This ")
        assert.equal(report[0].attempts![1].contentSent,"This is ")
        assert.equal(report[0].attempts![1].contentSent,"This is testing the brand new and shiny StreamingSequence server 3 ")
      });
      return attemptStream
  }

  let attemptStream;
  if (sequence.responses){
    const numResponses = sequence.responses.length
     attemptStream = await multipleSequenceAttempts(numResponses) 
  }else{
    const numResponses = 3
    attemptStream = await multipleSequenceAttempts(numResponses) 
  }
}

function retryStreamingRequest(){
  
  const request = new protos.google.showcase.v1beta1.CreateSequenceRequest()

  let firstDelay = new protos.google.protobuf.Duration();
  firstDelay.nanos=150;

  let firstStatus = new protos.google.rpc.Status();
  firstStatus.code=Status.DEADLINE_EXCEEDED;
  firstStatus.message="DEADLINE_EXCEEDED";

  let firstResponse = new protos.google.showcase.v1beta1.Sequence.Response();
  firstResponse.delay=firstDelay;
  firstResponse.status=firstStatus;

  // The Index you want the stream to fail or send the status 
  // This  should be index + 1 so if you want to send status at index 0 
  // you would provide firstResponse.responseIndex=1

  let secondDelay = new protos.google.protobuf.Duration();
  secondDelay.nanos=150;

  let secondStatus = new protos.google.rpc.Status();
  secondStatus.code=Status.OK;
  secondStatus.message="OK";

  let secondResponse = new protos.google.showcase.v1beta1.Sequence.Response();
  secondResponse.delay=secondDelay;
  secondResponse.status=secondStatus;

  let streamingSequence = new protos.google.showcase.v1beta1.Sequence()
  streamingSequence.responses = [firstResponse,secondResponse];
  request.sequence = streamingSequence

  return request
}

async function testStreaming(client: SequenceServiceClient) {

  const promise = new Promise(async (_, reject) => {

    const backoffSettings = createBackoffSettings(
        100,
        1.2,
        1000,
        null,
        1.5,
        3000,
        4500
      );
    
    const retryOptions = new RetryOptions([14],backoffSettings)

    let settings = {
      retry:retryOptions
    }

    client.initialize()

    const request = getStreamingSequenceRequest();
    const response = await client.createStreamingSequence(request);
    const sequence = response[0]

    let attemptRequest = new protos.google.showcase.v1beta1.AttemptStreamingSequenceRequest()
    attemptRequest.name = sequence.name!

    const attemptStream = await client.attemptStreamingSequence(attemptRequest,settings)
    attemptStream.on('data', (response: {content: string}) => {
      console.log("here")
      console.log("content: " + response.content);
    });

  });

}


function noRetryStreamingRequest(){
  
  const request = new protos.google.showcase.v1beta1.CreateStreamingSequenceRequest()

  let firstDelay = new protos.google.protobuf.Duration();
  firstDelay.nanos=150;

  let firstStatus = new protos.google.rpc.Status();
  firstStatus.code=Status.UNAVAILABLE;
  firstStatus.message="UNAVAILABLE";

  let firstResponse = new protos.google.showcase.v1beta1.StreamingSequence.Response();
  firstResponse.delay=firstDelay;
  firstResponse.status=firstStatus;

  // The Index you want the stream to fail or send the status 
  // This  should be index + 1 so if you want to send status at index 0 
  // you would provide firstResponse.responseIndex=1

  firstResponse.responseIndex=1;
  
  // We should never get to this sequence in this test because the call should not retry
  let secondDelay = new protos.google.protobuf.Duration();
  secondDelay.nanos=150;

  let secondStatus = new protos.google.rpc.Status();
  secondStatus.code=Status.DEADLINE_EXCEEDED;
  secondStatus.message="DEADLINE_EXCEEDED";

  let secondResponse = new protos.google.showcase.v1beta1.StreamingSequence.Response();
  secondResponse.delay=secondDelay;
  secondResponse.status=secondStatus;
  secondResponse.responseIndex=2

  // We should never get to this sequence in this test because the call should not retry
  let thirdDelay = new protos.google.protobuf.Duration();
  thirdDelay.nanos=500000;

  let thirdStatus = new protos.google.rpc.Status();
  thirdStatus.code=Status.OK;
  thirdStatus.message="OK";

  let thirdResponse = new protos.google.showcase.v1beta1.StreamingSequence.Response();
  thirdResponse.delay=thirdDelay;
  thirdResponse.status=thirdStatus;
  thirdResponse.responseIndex=11;

  let streamingSequence = new protos.google.showcase.v1beta1.StreamingSequence()
  streamingSequence.responses = [firstResponse,secondResponse,thirdResponse];
  streamingSequence.content = "This is testing the brand new and shiny StreamingSequence server 3";
  request.streamingSequence = streamingSequence

  return request
}
async function streamingNotRetryEligible(client: SequenceServiceClient) {

  const promise = new Promise(async (_, reject) => {
    client.initialize()

    const request = noRetryStreamingRequest();
    const response = await client.createStreamingSequence(request);
    const sequence = response[0]

    let attemptRequest = new protos.google.showcase.v1beta1.AttemptStreamingSequenceRequest()
    attemptRequest.name = sequence.name!

    const attemptStream = client.attemptStreamingSequence(attemptRequest)

    attemptStream.on('data', (response: {content: string}) => { console.log("content: " + response.content) });
    // Alex - We needed to "reject" this error instead of throwing it in order to make the test work
    // should we be able to have this test work properly with throw(err) instead of reject?
    // if so, we may need to make a change to the sequence service
    attemptStream.on('error', (err) => {reject(err)});  
    attemptStream.on('end', () => { /* API call completed */ });
  });

  promise.then(
  () => {
    assert(false);
  },
  (err: Error) => {
    assert.match(err.message, /UNAVAILABLE/);  // this error message should be the one sent in the first
  })

}

  

async function testEchoError(client: EchoClient) {
  const fixtureName = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'fixtures',
    'multipleErrors.json'
  );
  const protosPath = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'build',
    'protos',
    'google',
    'rpc'
  );

  const data = await fsp.readFile(fixtureName, 'utf8');
  const root = protobuf.loadSync(path.join(protosPath, 'error_details.proto'));
  const objs = JSON.parse(data);
  const details = [];
  const expectedDetails = [];
  let errorInfo: {domain: string; reason: string; metadata: [string, string]};
  for (const obj of objs) {
    const MessageType = root.lookupType(obj.type);
    const buffer = MessageType.encode(obj.value).finish();
    details.push({
      type_url: 'type.googleapis.com/' + obj.type,
      value: buffer,
    });
    expectedDetails.push(obj.value);
    if (obj.type === 'google.rpc.ErrorInfo') {
      errorInfo = obj.value;
    }
  }
  const request = {
    error: {
      code: 3,
      message: 'Test error',
      details: details,
    },
  };
  const timer = setTimeout(() => {
    throw new Error('End-to-end testEchoError method fails with timeout');
  }, 12000);
  await assert.rejects(() => client.echo(request), Error);
  try {
    await client.echo(request);
  } catch (err) {
    clearTimeout(timer);
    assert.strictEqual(
      JSON.stringify((err as GoogleError).statusDetails),
      JSON.stringify(expectedDetails)
    );
    assert.ok(errorInfo!);
    assert.strictEqual((err as GoogleError).domain, errorInfo!.domain);
    assert.strictEqual((err as GoogleError).reason, errorInfo!.reason);
    assert.strictEqual(
      JSON.stringify((err as GoogleError).errorInfoMetadata),
      JSON.stringify(errorInfo!.metadata)
    );
  }
}

async function testExpand(client: EchoClient) {
    const backoffSettings = createBackoffSettings(
      100,
      1.2,
      1000,
      null,
      1.5,
      3000,
      4500
    );

  const retryOptions = new RetryOptions([4],backoffSettings)

  let settings = {
    retry:retryOptions,
    error:{
      code:4,
      message:"deadline"
    }
  }

  const words = ['nobody', 'ever', 'reads', 'test', 'input'];
  const request = {
    content: words.join(' '),
  };
  const stream = client.expand(request,settings);
  const result: string[] = [];
  stream.on('data', (response: {content: string}) => {
    result.push(response.content);
  });
  stream.on('end', () => {
    assert.deepStrictEqual(words, result);
  });
}

async function testExpandThrows(client: EchoClient) {
  const words = ['nobody', 'ever', 'reads', 'test', 'input'];
  const request = {
    content: words.join(' '),
  };
  assert.throws(() => {
    const stream = client.expand(request);
    const result: string[] = [];
    stream.on('data', (response: {content: string}) => {
      result.push(response.content);
    });
    stream.on('end', () => {
      assert.deepStrictEqual(words, result);
    });
  }, /currently does not support/);
}

async function testPagedExpand(client: EchoClient) {
  const words = ['nobody', 'ever', 'reads', 'test', 'input'];
  const request = {
    content: words.join(' '),
    pageSize: 2,
  };
  const timer = setTimeout(() => {
    throw new Error('End-to-end testPagedExpand method fails with timeout');
  }, 12000);
  const [response] = await client.pagedExpand(request);
  clearTimeout(timer);
  const result = response.map(r => r.content);
  assert.deepStrictEqual(words, result);
}

async function testPagedExpandAsync(client: EchoClient) {
  const words = ['nobody', 'ever', 'reads', 'test', 'input'];
  const request = {
    content: words.join(' '),
    pageSize: 2,
  };
  const response = [];
  const iterable = client.pagedExpandAsync(request);
  const timer = setTimeout(() => {
    throw new Error(
      'End-to-end testPagedExpandAsync method fails with timeout'
    );
  }, 12000);
  for await (const resource of iterable) {
    response.push(resource.content);
  }
  clearTimeout(timer);
  assert.deepStrictEqual(words, response);
}

async function testCollect(client: EchoClient) {
  const words = ['nobody', 'ever', 'reads', 'test', 'input'];
  const promise = new Promise<string>((resolve, reject) => {
    try {
      const stream = client.collect((err, result) => {
        if (err || !result) {
          reject(err);
        } else {
          resolve(result.content ?? '');
        }
      });
      for (const word of words) {
        const request = {content: word};
        stream.write(request);
      }
      stream.on('data', (result: {content: String}) => {
        assert.deepStrictEqual(result.content, words.join(' '));
      });
      stream.end();
    } catch (err) {
      reject(err);
    }
  });
  const result = await promise;
  assert.strictEqual(result, words.join(' '));
}

async function testCollectThrows(client: EchoClient) {
  const words = ['nobody', 'ever', 'reads', 'test', 'input'];
  const promise = new Promise<string>((resolve, reject) => {
    try {
      const stream = client.collect((err, result) => {
        if (err || !result) {
          reject(err);
        } else {
          resolve(result.content ?? '');
        }
      });
      for (const word of words) {
        const request = {content: word};
        stream.write(request);
      }
      stream.on('data', (result: {content: String}) => {
        assert.deepStrictEqual(result.content, words.join(' '));
      });
      stream.end();
    } catch (err) {
      reject(err);
    }
  });
  // We expect the promise to be rejected
  promise.then(
    () => {
      assert(false);
    },
    (err: Error) => {
      assert.match(err.message, /currently does not support/);
    }
  );
}

async function testChat(client: EchoClient) {
  const words = [
    'nobody',
    'ever',
    'reads',
    'test',
    'input',
    'especially',
    'this',
    'one',
  ];
  const promise = new Promise((resolve, reject) => {
    try {
      const result: string[] = [];
      const stream = client.chat();
      stream.on('data', (response: {content: string}) => {
        result.push(response.content);
      });
      stream.on('end', () => {
        resolve(result);
      });
      stream.on('error', reject);
      for (const word of words) {
        stream.write({content: word});
      }
      stream.end();
    } catch (err) {
      reject(err);
    }
  });
  const result = await promise;
  assert.deepStrictEqual(result, words);
}

async function testChatThrows(client: EchoClient) {
  const words = [
    'nobody',
    'ever',
    'reads',
    'test',
    'input',
    'especially',
    'this',
    'one',
  ];
  const promise = new Promise((resolve, reject) => {
    try {
      const result: string[] = [];
      const stream = client.chat();
      stream.on('data', (response: {content: string}) => {
        result.push(response.content);
      });
      stream.on('end', () => {
        resolve(result);
      });
      stream.on('error', reject);
      for (const word of words) {
        stream.write({content: word});
      }
      stream.end();
    } catch (err) {
      reject(err);
    }
  });
  // We expect the promise to be rejected
  promise.then(
    () => {
      assert(false);
    },
    (err: Error) => {
      assert.match(err.message, /currently does not support/);
    }
  );
}

async function testWait(client: EchoClient) {
  const request = {
    ttl: {
      seconds: 5,
      nanos: 0,
    },
    success: {
      content: 'done',
    },
  };
  const [operation] = await client.wait(request);
  const [response] = await operation.promise();
  assert.deepStrictEqual(response.content, request.success.content);
}

async function main() {
  // const showcaseServer = new ShowcaseServer();
  // try {
  //   await showcaseServer.start();
  //   await testShowcase();
  // } finally {
  //   showcaseServer.stop();
  // }
  await testShowcase();
}


main();