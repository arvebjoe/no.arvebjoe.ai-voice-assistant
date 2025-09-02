# TODO
    This is stuff i want to bake into the app over time. 
    
    Please come with suggestions :) 


## When asking the agent from flow, don't chunk audio
    - Set pcm-segmenter to a high MIN_SILENCE_MS value. So that only one .flac file is created.
    - Or don't use the pcm-segmenter at all. Just straight pipe it directly without chunking it?
    - Having super fast response time when running this from a flow isn't necessary
    - More like a "nice to have" 


## Locally hosted AI
    - Whipsper
    - Piper
    - Ollama 
      - As an realtime agent?
      - Using gpt-oss? (omg!)


    Build a Simple AI Agent with OpenAI’s gpt-oss-20b 
    https://www.youtube.com/watch?v=e2sgwsC92Bc

    Build Anything with OpenAI’s New OSS Models (n8n Agents)
    https://www.youtube.com/watch?v=Myjo1amUZ08


## Customer ESP Home firmware
    - Homey look
      - The PE isn't restricted to use only blue in its LED ring, what about the homey "rainbow" ring spinning around?
<img src="./.resources/pe_rainbow.png" height="200" alt="XiaoZhi AI" />

    - Custom wake word
      - Any tool for making this?
        - "Hey Homey"
        - "Hei Homey" (Norwegian)
        - "My Homey"
        - "Major domo"  (https://www.audible.co.uk/pd/Service-Model-Audiobook/B0CMXTZZN2)


## Try to look at agent transcription.delta
    - Pass whatever we got back with agent.emit('silence', {text});
    - This will fill in the empty textbox on the XiaoZhi display


# ESPHome Voice assistant
    - Support esphome Api key, if anyone asks for it...
    - Needs to know where it is (zone). So it can controll devices within it's own zone if the user didn't specify the zone.
    - Still some issue with silence detection
    - Still issue with LED feedback when playing multiple URL's
        - Voice box should tell when it's done playing the last URL 

### AGENT TOOLS


### Tool - Start flows from agent
    * Start flow by name, "start <flow name>"
    * Start flow by synonym, "i'm going to bed" -> starts flow "night mode" - Need some way of letting user create connections between synonym and flow name

### Tool - Follow-up
    That way you don't have to speak the wake word again if the agent asks a question. One can just answer directly
    Need some kind of timeout if you don't have anything to say.


### Tool - Change settings (lot's of work, but would be cool)
    - Need to expose as a tool what settings can be changed by the agent.
    - Allowed settings are 'voice', 'language' and 'optional_ai_instructions'
    - Example:
      - User: "I want to change your voice"
      - Agent: "Sure, you can change my voice to alloy, ash, ballad, ... " 
        - This uses a tool to get all allowed voices from setting manager.
        - Also needs a tool to keep converation alive. Set a flag or something, that will set VoiceAssistantAnnounceRequest.startConverstion to "true".
      - User: "alloy"
      - Agent: "Changing voice to alloy"
        - Another tool. Will set {voice: "alloy"}.
        - And then the agent completes it's run.
        - Then after the agent is done do the actual change.
          - Socket will reconnect
        - Have the agent speak back with a new voice?

### Tool - Help!
    - Can ask agent what it can do. 

## Tool - Alarm or count down
    - This would be really nice to have
    - Looks like i can create alarm in the homey api:
        https://athombv.github.io/node-homey-api/HomeyAPIV3Local.ManagerAlarms.html
    - The AI could create an alarm based on the users wish. Either as at a specific time, or a calculated time based on count down value. The name of the alarm should be something that the AI will recognize, like "AI ALARM #001" or something
    - Then create a simple flow:
        When "Any alarm goes off" -> Then "AI agent handle alarm", and passing in the @name of the alarm that was the trigger.
    - If the AI recognizes the alarm, it looks for what it was supposed to do when that happended "by the name we gave the alarm".
        - Agent needs some kind of long term memory
        - Can homey run Sqlite? Is there something built in i can use?
        - Creating text files would also work.
    - Then delete the alarm


# Phase 2

## Image analysis?
    - Use AI agent to analyze an image together with a prompt? "Can you se any persons in the surveillance image?", "Is it dark out", "Who is at the door?"

## Even more tools?
    - Web search tool, have the Agent do a web search for some information. "What movies are in the cinema today?" (with geo location it could find the nearest one)

  
