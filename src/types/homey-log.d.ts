declare module 'homey-log' {
  import Homey from 'homey';
  export class Log {
    constructor(opts: { homey: Homey });
    // add methods you actually use here if you want stronger typing
  }
}
