declare module 'homey-log' {
  import Homey from 'homey';

  export class Log {
    constructor(opts: { homey: Homey });
    // add methods you actually use here if you want stronger typing
  }

  // The package's CommonJS module.exports is `{ Log }`, surfaced as the default
  // export under esModuleInterop — this is how app.mts consumes it
  // (`import homeyLogPkg from 'homey-log'; const { Log } = homeyLogPkg`).
  const homeyLog: { Log: typeof Log };
  export default homeyLog;
}
