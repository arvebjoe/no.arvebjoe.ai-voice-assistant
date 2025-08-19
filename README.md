# AI Voice Assistant



## Devices compatibility
    - Home Assistant Voice Preview edition  (PE)
    ![ESPHome Voice Box](./drivers/esphome-voice-box/assets/images/small.png)

    - XiaoZhi Ai
  
## How to flash PE
    - Use browser that supports accessing COM port, like Chrome. 
    - Go to: https://esphome.github.io/home-assistant-voice-pe/
    - Select version and hit Connect. Select the COM port to which the PE is connected.
    - Click "Install Nabu Casa....."
    - Once installed, set the wifi credentials.
    - Give the device a static IP in your network

## How to flash XiaoZhi AI
    - https://github.com/RealDeco/xiaozhi-esphome


## Supported AI providers
    - OpenAI
    - Locally hosted (wyoming, ollama)



## TODO before release:

### Agent system prompt
    - Need to tell agent what language is should answer in i.e. "norwegian", "english" or "pirate". 
    - Needs to come from app-settings 
    - Just write it in for release 1.0.0
    - Perhaps pulldown with auto complete in the future?

### Support for Xiaozhi Ai
    - These stream using Flac

### Add new device
    - This is weak. Need to connect to each esp device and ask it's capabilities.
    - Need to support api key?

### Voice Box
    - Needs to know where it is (zone). So it can controll devices within it's own zone if the user didn't specify the zone.
    - Still some issue with silence detection
    - Still issue with LED feedback when playing multiple URL's
    - Voice box should tell when it's done playing the last URL 
      - How to do this?


### Homey-log
    - What is it?
    - Do we need it?
    - https://www.npmjs.com/package/homey-log


### Flow cards

#### WHEN
    - Device starts listening
    - Device stops listening
    - Device starts playback (of wav file)
    - Device ends playback (of wav file)
    
#### AND
    - Device is listening
    - Device is playing
    - Device is muted

#### THEN
    - Device start listening. Output as wav or text
    - Device begin playback for wav or text
    - Device set volume
    - Device set mute (on/off)

    - App trigger Agent with text prompt. Output as wav or text

















## TODO after release

### Locally hosted AI
    - Whipsper
    - Piper
    - Ollama

### Settings
    - Debug mode (on/off). Will show live logging. Saves both rx and tx wav files for a while.


### Agent tools
    - Start flow by name, "start <flow name>"
    - Start flow by synonym, "i'm going to bed" -> starts flow "night mode" - Need some way of letting user create connections between synonym and flow name

### Alarm or count down
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


## Phase 2

### Image analysis?
    - Use AI agent to analyze an image together with a prompt? "Can you se any persons in the surveillance image?", "Is it dark out", "Who is at the door?"

### Sound effects?
    - Host some wav files on github, that can be played by the voice box (just push an wav url at it.) Would need some index to read..

### Tools?
    - Web search tool, have the Agent do a web search for some information. "What movies are in the cinema today?" (with geo location it could find the nearest one)
