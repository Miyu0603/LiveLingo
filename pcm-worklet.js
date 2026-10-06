// AudioWorkletProcessor: downsamples the tab's audio to 16kHz mono Int16 PCM
// and posts fixed-size chunks back to the offscreen document for streaming to Deepgram.

class PCMDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.targetSampleRate = opts.targetSampleRate || 16000;
    this.inputSampleRate = sampleRate; // global provided by AudioWorkletGlobalScope
    this.ratio = this.inputSampleRate / this.targetSampleRate;
    this.chunkSize = 3200; // ~200ms of audio at 16kHz
    this.buffer = new Int16Array(this.chunkSize);
    this.bufferIndex = 0;
    this.carry = 0; // fractional leftover for decimation accumulator
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channelData = input[0]; // mono-mix: just use first channel
    if (!channelData) return true;

    let i = this.carry;
    for (; i < channelData.length; i += this.ratio) {
      const idx = Math.floor(i);
      // simple averaging window to reduce aliasing
      let sum = 0;
      let count = 0;
      const windowEnd = Math.min(idx + Math.round(this.ratio), channelData.length);
      for (let j = idx; j < windowEnd; j++) {
        sum += channelData[j];
        count++;
      }
      const sample = count > 0 ? sum / count : channelData[idx] || 0;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.buffer[this.bufferIndex++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;

      if (this.bufferIndex >= this.chunkSize) {
        const outBuffer = this.buffer.buffer;
        this.port.postMessage(outBuffer, [outBuffer]);
        this.buffer = new Int16Array(this.chunkSize);
        this.bufferIndex = 0;
      }
    }
    this.carry = i - channelData.length;

    return true;
  }
}

registerProcessor('pcm-downsampler', PCMDownsampler);
