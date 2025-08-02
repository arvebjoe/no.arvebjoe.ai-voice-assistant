'use strict';

require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const HomeyClient = require('./homey-client');

// Initialize HomeyClient
const homeyClient = new HomeyClient('192.168.0.99', 7709);

/**
 * Process a user's input and provide a response using OpenAI
 * @param {string} userInput - The user's input text
 * @returns {Promise<string>} The assistant's response
 */
async function processUserInput(userInput) {
  try {
    // Import OpenAI SDK (ESM)
    const OpenAIModule = await import('openai');
    const OpenAI = OpenAIModule.default || OpenAIModule.OpenAI;
    
    // Initialize the OpenAI client
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    
    // Initialize HomeyClient if not already initialized
    if (!homeyClient.devices || !homeyClient.zones) {
      await homeyClient.initialize();
      console.log('HomeyClient initialized');
    }
    
    // Prepare system message with context about the smart home
    let systemMessage = `
      You are a helpful smart home assistant. You can control devices in the user's home.
      
      The user has the following types of devices:
      ${JSON.stringify(await homeyClient.getAllDeviceTypes())}
      
      The user has devices in the following zones:
      ${JSON.stringify(await homeyClient.getZones())}
      
      When the user asks to control a device or get information about their smart home,
      you should provide helpful and accurate responses based on this context.
      
      Common device capabilities:
      - lights: "onoff" (true/false), "dim" (0-1)
      - locks: "locked" (true/false)
      - thermostats: "target_temperature" (number)
      - plugs/sockets: "onoff" (true/false)
      
      If the user asks a question unrelated to home automation, just answer normally.
    `;

    // If the user is asking about controlling a device
    if (userInput.toLowerCase().includes('turn') || 
        userInput.toLowerCase().includes('set') || 
        userInput.toLowerCase().includes('dim') ||
        userInput.toLowerCase().includes('lock') ||
        userInput.toLowerCase().includes('unlock')) {
      
      // Get device data for the AI to work with
      const allDevices = await homeyClient.getSmartHomeDevices();
      
      // Add device data to system message
      systemMessage += `\nHere are the first 10 devices (as a sample) that can be controlled:
      ${JSON.stringify(allDevices.devices.slice(0, 10), null, 2)}
      
      When the user asks to control a device, you should respond with what action would be taken.
      For example, "I would turn on the kitchen light" or "I would set the thermostat to 72 degrees".
      
      In this demo mode, no actual device control will happen, but you should respond as if it would.
      `;
    }
    
    // Create chat completion
    const chatCompletion = await openai.chat.completions.create({
      model: "gpt-4-0125-preview",
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userInput }
      ],
      temperature: 0.7
    });

    // Return the assistant's response
    return chatCompletion.choices[0].message.content;
  } catch (error) {
    console.error('Error processing user input:', error);
    return `I'm sorry, I encountered an error processing your request: ${error.message}`;
  }
}

/**
 * Main function for demonstration
 */
async function main() {
  try {
    console.log('Starting main function...');
    
    // Initialize HomeyClient
    await homeyClient.initialize();
    console.log('HomeyClient initialized');
    
    // Example questions to demonstrate capabilities
    const questions = [
      "What types of devices do I have in my smart home?",
      "How many zones are there in my home?",
      "Turn on the kitchen lights",
      "What's the weather like today?",
      "Dim the bedroom lights to 50%"
    ];
    
    // Process each question
    for (const question of questions) {
      console.log(`\nUser: ${question}`);
      const response = await processUserInput(question);
      console.log(`Assistant: ${response}`);
    }
    
    console.log('\nMain function completed');
  } catch (error) {
    console.error('Error in main function:', error);
  }
}

// Export functions
module.exports = {
  main,
  processUserInput
};

// Run the main function if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}
