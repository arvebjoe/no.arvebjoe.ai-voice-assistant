'use strict';
const {Agent, setDefaultOpenAIKey, run } = require('@openai/agents');

class SmartAgent {
    constructor(toolMaker, apiKey) {
        this.toolMaker = toolMaker;
        this.apiKey = apiKey;

		this.tools = this.toolMaker.createTools();			
    	setDefaultOpenAIKey(this.apiKey); 
		
		this.agent = null;
		this.thread = []; 
    }

    async initialize() {
		// TODO: Needed?
    } 

	async run(input) {


		if(!this.agent){
			
			this.agent = new Agent({
					name: 'Smart Home Assistant',
					model: 'gpt-4.1-nano',//'gpt-3.5-turbo',
					instructions: `
						You are a helpful smart home assistant. You can control devices in the user's home using the tools provided.
						When the user asks to control a device:

						1. First check what types of devices are available using getAllDeviceTypes()
						2. If needed, check what zones exist using getZones()
						3. Find the relevant devices using getSmartHomeDevices(). Zone and Type are optional, but can help narrow down the search. But if  you don't know the zone or type, you can leave them empty.
						4. Control the devices using setDeviceCapability()
						5. If the user asks about the weather, use getWeatherTool()
						6. If the user asks for a fun fact, use historyFunFact()

			
						Common device capabilities:
						- lights: "onoff" (true/false), "dim" (0-1)
						- locks: "locked" (true/false)
						- thermostats: "target_temperature" (number)
						- plugs/sockets: "onoff" (true/false)

						Respond in a natural, helpful way. After completing an action, confirm what you did in a friendly manner.
						If you can't find a matching device or the request is unclear, ask for clarification.
						If the user asks a question unrelated to home automation, just answer normally without using the tools.
						Always start by determining whether the request involves smart home control or is just a general question.
					`,
					// Adding the tool to the agent
					tools: Object.values(this.tools),
			});
		}

		this.thread.push({ role: 'user', content: input });

		const result = await run(this.agent, this.thread);
		
		this.thread = result.history;

		return result.finalOutput;
	}
		
}


module.exports = Agent;


