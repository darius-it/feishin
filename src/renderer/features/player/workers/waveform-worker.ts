/**
 * Web Worker that extracts waveform peaks from raw PCM channel data.
 * Receives pre-decoded Float32Array channel data from the main thread
 * and performs the CPU-intensive peak extraction off the main thread.
 */

self.onmessage = (
    e: MessageEvent<{ channelData: Float32Array[]; duration: number; samples?: number }>,
) => {
    const { channelData, duration, samples = 1024 } = e.data;

    try {
        const peaks: Float32Array[] = [];

        for (let ch = 0; ch < channelData.length; ch++) {
            const rawData = channelData[ch];
            const blockSize = Math.floor(rawData.length / samples);
            const peakData = new Float32Array(samples);

            for (let i = 0; i < samples; i++) {
                let max = 0;
                const offset = i * blockSize;
                for (let j = 0; j < blockSize; j++) {
                    const abs = Math.abs(rawData[offset + j]);
                    if (abs > max) max = abs;
                }
                peakData[i] = max;
            }
            peaks.push(peakData);
        }

        // Transfer the buffers to avoid copying
        self.postMessage(
            { duration, peaks },
            peaks.map((p) => p.buffer) as unknown as Transferable[],
        );
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        self.postMessage({ error: message });
    }
};
