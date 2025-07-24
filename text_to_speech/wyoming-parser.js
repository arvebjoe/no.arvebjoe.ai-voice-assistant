// wyoming-parser.js ----------------------------------------------------------
const EventEmitter = require('events');


class WyomingParser extends EventEmitter {
  constructor() {
    super();
    this.buf = Buffer.alloc(0);
    this.reset();
  }

  reset() {
    this.header = null;      // header JSON
    this.wantData = 0;       // bytes of extra data left
    this.wantPayload = 0;    // bytes of payload left
    this.dataBuf = Buffer.alloc(0);
    this.payloadBuf = Buffer.alloc(0);
  }

  /** feed() with whatever you got from net.Socket */
  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);

    // we may have multiple events waiting in the buffer
    while (true) {
      // 1) no header yet – look for newline-terminated UTF-8 header
      if (!this.header) {
        const nl = this.buf.indexOf(0x0a);      // LF
        if (nl === -1) {
          return;                  // not complete yet
        }
        const headerStr = this.buf.slice(0, nl).toString('utf8');
        this.buf = this.buf.slice(nl + 1);      // drop LF
        this.header = JSON.parse(headerStr);

        this.wantData    = this.header.data_length    ?? 0;
        this.wantPayload = this.header.payload_length ?? 0;
      }

      // 2) read additional data block (if any)
      if (this.wantData) {
        if (this.buf.length < this.wantData) {
          return; // wait for more
        }
        this.dataBuf = this.buf.slice(0, this.wantData);
        this.buf     = this.buf.slice(this.wantData);
        this.wantData = 0;
      }

      // 3) read payload block (if any)
      if (this.wantPayload) {
        if (this.buf.length < this.wantPayload) {
          return; // wait
        }
        this.payloadBuf = this.buf.slice(0, this.wantPayload);
        this.buf        = this.buf.slice(this.wantPayload);
        this.wantPayload = 0;
      }

      // 4) we have a complete event – emit it
      const evt = {
        header : this.header,
        ...(this.dataBuf.length && {data: JSON.parse(this.dataBuf)}),
        ...(this.payloadBuf.length && {payload: this.payloadBuf}),
      };
      this.emit('event', evt);

      // 5) …and start over for the next one
      this.reset();
    }
  }
}

module.exports = {
  WyomingParser
};