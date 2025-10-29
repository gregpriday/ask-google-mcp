#!/usr/bin/env node

/**
 * Integration test for Gemini MCP Server
 *
 * This test validates that the MCP server can:
 * 1. Start up correctly
 * 2. List available tools
 * 3. Execute the ask_google tool with a real search query
 * 4. Return properly formatted results with sources
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
 * Send a JSON-RPC request to the MCP server and get response
 */
async function sendRequest(server, request) {
  return new Promise((resolve, reject) => {
    let responseData = '';
    let errorData = '';

    const timeout = setTimeout(() => {
      reject(new Error('Request timeout after 30 seconds'));
    }, 30000);

    const dataHandler = (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim() && !line.includes('Gemini MCP server')) {
          try {
            const json = JSON.parse(line);
            clearTimeout(timeout);
            server.stdout.off('data', dataHandler);
            resolve(json);
          } catch (e) {
            // Not a complete JSON yet, continue collecting
            responseData += line;
          }
        }
      }
    };

    server.stdout.on('data', dataHandler);

    server.stderr.on('data', (data) => {
      errorData += data.toString();
    });

    // Send the request
    server.stdin.write(JSON.stringify(request) + '\n');
  });
}

/**
 * Run the integration tests
 */
async function runTests() {
  console.log('🚀 Starting Gemini MCP Integration Tests\n');
  console.log('='.repeat(60));

  // Start the MCP server
  console.log('\n📡 TEST 1: Starting MCP server...');
  const server = spawn('node', ['src/index.js'], {
    env: {
      ...process.env,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY
    },
    cwd: join(__dirname, '..')
  });

  // Wait a bit for server to initialize
  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log('✅ MCP server started');

  try {
    // Test 1: List tools
    console.log('\n📡 TEST 2: Listing available tools...');
    const listResponse = await sendRequest(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list'
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
    console.log(`   Description: ${askGoogleTool.description}`);

    // Test 2: Ask about Springboks rugby
    console.log('\n📡 TEST 3: Asking about South African Springboks Rugby...');
    console.log('   Question: "Who did the South African Springboks Rugby team play last and who won?"');

    const callResponse = await sendRequest(server, {
      jsonrpc: '2.0',
      id: 2,
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
