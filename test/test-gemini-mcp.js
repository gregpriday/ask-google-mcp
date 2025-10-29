#!/usr/bin/env node

/**
 * Integration test for Gemini MCP Server
 *
 * NOTE: This test requires a real GOOGLE_API_KEY and performs actual API calls.
 * It validates the MCP protocol handshake and tool execution end-to-end.
 *
 * This test validates that the MCP server can:
 * 1. Start up correctly
 * 2. Complete MCP initialization handshake (initialize -> initialized)
 * 3. List available tools
 * 4. Execute the ask_google tool with a real search query
 * 5. Return properly formatted results with sources
 *
 * For faster unit testing without API calls, see test/unit/*.test.js
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env file from project root
dotenv.config({ path: join(__dirname, '..', '.env') });

// Verify API key is loaded
if (!process.env.GOOGLE_API_KEY) {
  console.error('❌ ERROR: GOOGLE_API_KEY not found in .env file');
  process.exit(1);
}

console.log('✅ GOOGLE_API_KEY loaded from .env file');
console.log('');

/**
 * Encode a JSON-RPC message with Content-Length framing
 */
function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = `Content-Length: ${body.length}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, 'utf8'), body]);
}

/**
 * Decode framed JSON-RPC messages from a buffer
 */
function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n', offset, 'utf8');
    if (headerEnd === -1) break;

    const header = buffer.toString('utf8', offset, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) break;

    const length = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) break;

    const json = JSON.parse(buffer.toString('utf8', bodyStart, bodyEnd));
    messages.push(json);
    offset = bodyEnd;
  }
  return { messages, remaining: buffer.slice(offset) };
}

/**
 * Send a JSON-RPC request to the MCP server and get response
 */
async function sendRequest(server, request) {
  return new Promise((resolve, reject) => {
    let responseBuffer = Buffer.alloc(0);

    const timeout = setTimeout(() => {
      reject(new Error('Request timeout after 30 seconds'));
    }, 30000);

    const dataHandler = (data) => {
      responseBuffer = Buffer.concat([responseBuffer, data]);

      const { messages, remaining } = decodeFrames(responseBuffer);
      responseBuffer = remaining;

      if (messages.length > 0) {
        clearTimeout(timeout);
        server.stdout.off('data', dataHandler);
        resolve(messages[0]);
      }
    };

    server.stdout.on('data', dataHandler);

    // Send the framed request
    server.stdin.write(encodeMessage(request));
  });
}

/**
 * Run the integration tests
 */
async function runTests() {
  console.log('🚀 Starting Gemini MCP Integration Tests\n');
  console.log('='.repeat(60));

  // Start the MCP server (skip npm scripts to avoid prestart hook)
  console.log('\n📡 TEST 1: Starting MCP server...');
  const server = spawn('node', ['src/index.js'], {
    env: {
      ...process.env,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
      GEMINI_MODEL: process.env.GEMINI_MODEL || 'models/gemini-2.5-pro-latest'
    },
    cwd: join(__dirname, '..'),
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Log stderr for debugging
  server.stderr.on('data', (data) => {
    const msg = data.toString();
    if (!msg.includes('Gemini MCP server')) {
      console.error('   [server stderr]:', msg.trim());
    }
  });

  // Wait a bit for server to initialize
  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log('✅ MCP server started');

  try {
    // Test 1: Initialize handshake
    console.log('\n📡 TEST 2: Performing MCP initialization handshake...');

    // Step 1: Send initialize request
    const initResponse = await sendRequest(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        clientInfo: {
          name: 'ask-google-test-client',
          version: '1.0.0'
        },
        capabilities: {}
      }
    });

    if (!initResponse.result) {
      throw new Error('No result in initialize response');
    }
    console.log('✅ Initialize handshake completed');

    // Step 2: Send initialized notification (no response expected)
    server.stdin.write(encodeMessage({
      jsonrpc: '2.0',
      method: 'initialized',
      params: {}
    }));

    // Wait a bit for notification to be processed
    await new Promise(resolve => setTimeout(resolve, 100));
    console.log('✅ Initialized notification sent');

    // Test 2: List tools
    console.log('\n📡 TEST 3: Listing available tools...');
    const listResponse = await sendRequest(server, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    });

    if (!listResponse.result?.tools) {
      throw new Error('No tools returned from server');
    }

    const askGoogleTool = listResponse.result.tools.find(t => t.name === 'ask_google');
    if (!askGoogleTool) {
      throw new Error('ask_google tool not found');
    }

    console.log('✅ Tools listed successfully');
    console.log(`   Found tool: ${askGoogleTool.name}`);
    console.log(`   Description: ${askGoogleTool.description.substring(0, 80)}...`);

    // Test 3: Ask about Springboks rugby
    console.log('\n📡 TEST 4: Asking about South African Springboks Rugby...');
    console.log('   Question: "Who did the South African Springboks Rugby team play last and who won?"');

    const callResponse = await sendRequest(server, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'ask_google',
        arguments: {
          question: 'Who did the South African Springboks Rugby team play last and who won?'
        }
      }
    });

    if (!callResponse.result?.content) {
      throw new Error('No content in response');
    }

    const textContent = callResponse.result.content.find(c => c.type === 'text');
    if (!textContent) {
      throw new Error('No text content in response');
    }

    console.log('✅ Response received successfully');
    console.log('\n' + '='.repeat(60));
    console.log('📄 RESPONSE:');
    console.log('='.repeat(60));
    console.log(textContent.text);
    console.log('='.repeat(60));

    // Verify response has sources
    if (!textContent.text.includes('Sources:')) {
      console.log('⚠️  WARNING: No sources found in response');
    } else {
      console.log('\n✅ Response includes sources');
    }

    // Verify response has search queries
    if (!textContent.text.includes('Search queries performed:')) {
      console.log('⚠️  WARNING: No search queries found in response');
    } else {
      console.log('✅ Response includes search queries performed');
    }

    console.log('\n' + '='.repeat(60));
    console.log('🎉 ALL TESTS PASSED!');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\n❌ TEST FAILED:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    // Clean up
    server.kill();
    process.exit(0);
  }
}

// Run tests
runTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
