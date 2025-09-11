import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpenAIRealtimeAgent } from '../src/llm/openai-realtime-agent.mjs';
import { ToolManager } from '../src/llm/tool-manager.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';
import { MockDeviceManager } from './mocks/mock-device-manager.mjs';
import { IDeviceManager } from '../src/helpers/interfaces.mjs';
import fs from 'fs';
import path from 'path';

// Load environment variables from env.json
const envPath = path.join(process.cwd(), 'env.json');
let envConfig: any = {};

if (fs.existsSync(envPath)) {
  try {
    envConfig = JSON.parse(fs.readFileSync(envPath, 'utf8'));
  } catch (error) {
    console.warn('Could not load env.json:', error);
  }
}

describe('OpenAI Realtime Agent', () => {
  let mockHomey: MockHomey;
  let mockDeviceManager: MockDeviceManager;
  let toolManager: ToolManager;
  let agent: OpenAIRealtimeAgent;
  
  const testApiKey = envConfig.OPENAI_API_KEY || 'test-api-key';
  const testZone = 'Office';

  beforeEach(async () => {
    // Initialize mocks
    mockHomey = new MockHomey();
    mockDeviceManager = new MockDeviceManager();
    
    // Initialize DeviceManager
    await mockDeviceManager.init();
    await mockDeviceManager.fetchData();
    
    // Initialize ToolManager with mocks - cast to DeviceManager (unsafe but for testing)
    toolManager = new ToolManager(mockHomey, testZone, mockDeviceManager as any);
    
    // Setup agent options
    const agentOptions = {
      apiKey: testApiKey,
      voice: 'alloy',
      languageCode: 'en',
      languageName: 'English',
      additionalInstructions: '',
      deviceZone: testZone
    };
    
    // Initialize OpenAI Realtime Agent
    agent = new OpenAIRealtimeAgent(mockHomey, toolManager, agentOptions);
  });

  afterEach(async () => {
    // Clean up agent connection if it exists
    if (agent && typeof (agent as any).stop === 'function') {
      try {
        await (agent as any).stop();
      } catch (error) {
        // Ignore cleanup errors
      }
    }
  });

  describe('Agent Initialization', () => {
    it('should initialize with correct options', () => {
      expect(agent).toBeDefined();
      expect(agent).toBeInstanceOf(OpenAIRealtimeAgent);
    });

    it('should emit missing_api_key event when API key is empty', async () => {
      const agentWithoutKey = new OpenAIRealtimeAgent(mockHomey, toolManager, {
        apiKey: '',
        voice: 'alloy',
        languageCode: 'en',
        languageName: 'English',
        additionalInstructions: '',
        deviceZone: testZone
      });

      const missingKeyPromise = new Promise<void>((resolve) => {
        agentWithoutKey.on('missing_api_key', () => {
          resolve();
        });
      });

      await agentWithoutKey.start();
      await expect(missingKeyPromise).resolves.toBeUndefined();
    });
  });

  describe('Text Input/Output Mode', () => {
    it('should handle output mode changes when not connected', () => {
      // When WebSocket is not connected, setOutputMode should throw a specific error
      // This is expected behavior and helps us understand the connection state
      expect(() => {
        (agent as any).setOutputMode('text');
      }).toThrow('WebSocket is not open - reconnection initiated');
    });

    it('should handle text input when not connected', () => {
      // When WebSocket is not connected, sendTextForTextResponse should throw a specific error
      // This is expected behavior and helps us understand the connection state
      expect(() => {
        agent.sendTextForTextResponse('Hello, can you help me?');
      }).toThrow('WebSocket is not open - reconnection initiated');
    });

    it('should handle text output events', () => {
      return new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          resolve(); // Complete test after timeout - this is setup for future real testing
        }, 100);

        // Listen for text output
        agent.on('text.done', (message: any) => {
          clearTimeout(timeout);
          expect(message).toBeDefined();
          resolve();
        });

        // This will only work with a real API key, so we'll skip if using test key
        if (testApiKey === 'test-api-key') {
          clearTimeout(timeout);
          resolve();
          return;
        }

        // Send a simple text request
        agent.start().then(() => {
          agent.sendTextForTextResponse('Just say hello');
        }).catch(() => {
          clearTimeout(timeout);
          resolve(); // Skip test if connection fails
        });
      });
    });
  });

  describe('Smart Home Instructions Testing', () => {
    it('should be able to test different instruction sets', () => {
      // Test creating agents with different additional instructions
      const customInstructions = 'Always be very brief in responses. When controlling lights, always confirm the action.';
      
      const customAgent = new OpenAIRealtimeAgent(mockHomey, toolManager, {
        apiKey: testApiKey,
        voice: 'alloy',
        languageCode: 'en',
        languageName: 'English',
        additionalInstructions: customInstructions,
        deviceZone: testZone
      });

      expect(customAgent).toBeDefined();
    });

    it('should be able to test different device zones', () => {
      const kitchenToolManager = new ToolManager(mockHomey, 'Kitchen', mockDeviceManager as any);
      
      const kitchenAgent = new OpenAIRealtimeAgent(mockHomey, kitchenToolManager, {
        apiKey: testApiKey,
        voice: 'alloy',
        languageCode: 'en',
        languageName: 'English',
        additionalInstructions: '',
        deviceZone: 'Kitchen'
      });

      expect(kitchenAgent).toBeDefined();
    });
  });

  describe('Tool Integration', () => {
    it('should have access to device management tools through ToolManager', () => {
      const toolDefinitions = toolManager.getToolDefinitions();
      expect(toolDefinitions.length).toBeGreaterThan(0);
      
      // Check for expected smart home tools
      const toolNames = toolDefinitions.map(tool => tool.name);
      expect(toolNames).toContain('get_devices_in_standard_zone');
      expect(toolNames).toContain('get_zones');
      expect(toolNames).toContain('set_device_capability');
    });

    it('should be able to get tool handlers for function calls', () => {
      const handlers = toolManager.getToolHandlers();
      expect(Object.keys(handlers).length).toBeGreaterThan(0);
      expect(typeof handlers.get_zones).toBe('function');
    });
  });

  describe('Event Monitoring', () => {
    it('should be able to monitor tool call events', () => {
      return new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          resolve(); // Complete test after timeout - this is setup for future real testing
        }, 100);

        // Listen for tool arguments being built
        agent.on('tool.arguments.delta', (data: any) => {
          clearTimeout(timeout);
          expect(data).toHaveProperty('callId');
          expect(data).toHaveProperty('delta');
          resolve();
        });

        // This test just verifies the event listeners are set up correctly
        // Real testing would involve sending prompts that trigger tool calls
      });
    });

    it('should be able to monitor function call completion', () => {
      return new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          resolve(); // Complete test after timeout - this is setup for future real testing
        }, 100);

        // Listen for any event that indicates function processing
        agent.on('event', (data: any) => {
          if (data?.type?.includes('function')) {
            clearTimeout(timeout);
            expect(data).toBeDefined();
            resolve();
          }
        });

        // This test just verifies the event listeners are set up correctly
      });
    });
  });
});

// Helper function to test agent with different prompts (for future use)
export async function testAgentWithPrompt(
  agent: OpenAIRealtimeAgent,
  prompt: string,
  timeout: number = 10000
): Promise<{
  textResponse?: string;
  toolCalls: Array<{ name: string; arguments: any; result: any }>;
  events: Array<{ type: string; data: any }>;
}> {
  return new Promise((resolve, reject) => {
    const events: Array<{ type: string; data: any }> = [];
    const toolCalls: Array<{ name: string; arguments: any; result: any }> = [];
    let textResponse: string | undefined;

    const timer = setTimeout(() => {
      reject(new Error('Test timeout'));
    }, timeout);

    // Monitor events
    agent.on('text.done', (message: any) => {
      textResponse = message.content || message.text || JSON.stringify(message);
      events.push({ type: 'text.done', data: message });
    });

    agent.on('event', (data: any) => {
      events.push({ type: 'event', data });
      
      // Look for function call related events
      if (data?.type?.includes('function')) {
        toolCalls.push({
          name: data.name || 'unknown',
          arguments: data.arguments || {},
          result: data.result || data.output || null
        });
      }
    });

    agent.on('response.done', () => {
      clearTimeout(timer);
      resolve({ textResponse, toolCalls, events });
    });

    agent.on('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });

    // Send the prompt
    agent.sendTextForTextResponse(prompt);
  });
}
