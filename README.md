# AI Voice Assistant for Homey

This app provides a voice assistant capability for Homey, serving audio streams via a web server.

## Development

### Running the app

To run the app during development, use:

```bash
homey app run --remote
```

This runs the app directly on your Homey device instead of in a local Docker container, ensuring:

1. The app has direct access to the Homey's network interfaces
2. The IP address is correctly set to the Homey's actual IP (e.g. 192.168.0.99)
3. All ports opened by the app are directly accessible on the Homey's network address
4. Docker port mapping issues are avoided

### Accessing the web server

When the app is running, the web server can be accessed at:
```
http://[homey-ip]:3100/
```

For example:
```
http://192.168.0.99:3100/
```

The web interface allows you to:
- View available audio streams
- Create test audio streams
- Play audio directly in the browser

## Installation

To install the app to your Homey device:

```bash
homey app install
```

## Features

- Audio streaming server
- WAV file conversion
- Test tone generation
- Web-based audio player interface

## Technical Details

The app uses:
- Express.js for the web server
- PCM to WAV conversion for audio formats
- Homey SDK for device integration
