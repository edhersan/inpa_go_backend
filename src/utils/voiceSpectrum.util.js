const FFT_SIZE = 512;
const HOP_SIZE = 256;
const NUM_BANDS = 16;
const SILENCE_RMS_THRESHOLD = 0.0005;

function buildHammingWindow(size) {
  const win = new Float64Array(size);
  for (let n = 0; n < size; n += 1) {
    win[n] = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (size - 1));
  }
  return win;
}

const HAMMING_WINDOW = buildHammingWindow(FFT_SIZE);

function fftRadix2(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) {
    throw new Error('FFT_SIZE debe ser potencia de 2.');
  }

  // Permutación por inversión de bits
  let j = 0;
  for (let i = 0; i < n; i += 1) {
    if (i < j) {
      const tmpRe = re[i];
      re[i] = re[j];
      re[j] = tmpRe;

      const tmpIm = im[i];
      im[i] = im[j];
      im[j] = tmpIm;
    }
    let bit = n >> 1;
    while (bit > 0 && j >= bit) {
      j -= bit;
      bit >>= 1;
    }
    j += bit;
  }

  // Mariposas Cooley-Tukey Radix-2
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wStepRe = Math.cos(angle);
    const wStepIm = Math.sin(angle);

    for (let start = 0; start < n; start += len) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < halfLen; k += 1) {
        const evenIdx = start + k;
        const oddIdx = evenIdx + halfLen;

        const tRe = wRe * re[oddIdx] - wIm * im[oddIdx];
        const tIm = wRe * im[oddIdx] + wIm * re[oddIdx];

        re[oddIdx] = re[evenIdx] - tRe;
        im[oddIdx] = im[evenIdx] - tIm;
        re[evenIdx] += tRe;
        im[evenIdx] += tIm;

        const nextWRe = wRe * wStepRe - wIm * wStepIm;
        wIm = wRe * wStepIm + wIm * wStepRe;
        wRe = nextWRe;
      }
    }
  }
}

function decodeAudioSamples(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return new Float64Array(0);
  }

  // Detectar cabecera RIFF/WAVE PCM estándar
  const isWav =
    buffer.length >= 44 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WAVE';

  if (isWav) {
    let bitsPerSample = 16;
    let dataOffset = 44;
    let dataSize = buffer.length - 44;
    let offset = 12;

    while (offset + 8 <= buffer.length) {
      const chunkId = buffer.toString('ascii', offset, offset + 4);
      const chunkSize = buffer.readUInt32LE(offset + 4);
      const chunkStart = offset + 8;

      if (chunkId === 'fmt ' && chunkStart + 16 <= buffer.length) {
        bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
      } else if (chunkId === 'data') {
        dataOffset = chunkStart;
        dataSize = Math.min(chunkSize, buffer.length - chunkStart);
        break;
      }

      offset = chunkStart + chunkSize + (chunkSize % 2);
    }

    if (bitsPerSample === 8) {
      const samples = new Float64Array(dataSize);
      for (let i = 0; i < dataSize; i += 1) {
        samples[i] = (buffer.readUInt8(dataOffset + i) - 128) / 128;
      }
      return samples;
    }

    const sampleCount = Math.floor(dataSize / 2);
    const samples = new Float64Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
      samples[i] = buffer.readInt16LE(dataOffset + i * 2) / 32768;
    }
    return samples;
  }

  // Formatos comprimidos (M4A/MP3/WebM): decodificación directa sobre payload en memoria
  const headerSkip = buffer.length > 128 ? 64 : 0;
  const usableBytes = buffer.length - headerSkip;
  const sampleCount = Math.floor(usableBytes / 2);
  const samples = new Float64Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    samples[i] = buffer.readInt16LE(headerSkip + i * 2) / 32768;
  }
  return samples;
}

function extractVoiceSignature(buffer) {
  const samples = decodeAudioSamples(buffer);
  if (samples.length < FFT_SIZE) {
    return {
      vector: new Array(NUM_BANDS + 2).fill(0),
      activeFrames: 0,
      totalFrames: 0,
    };
  }

  const accumBands = new Float64Array(NUM_BANDS);
  let accumCentroid = 0;
  let accumZcr = 0;
  let activeFrames = 0;
  let totalFrames = 0;

  const halfFft = FFT_SIZE / 2;
  const binsPerBand = Math.floor(halfFft / NUM_BANDS);

  for (let offset = 0; offset + FFT_SIZE <= samples.length; offset += HOP_SIZE) {
    totalFrames += 1;

    let sumSq = 0;
    let zeroCrossings = 0;
    for (let i = 0; i < FFT_SIZE; i += 1) {
      const s = samples[offset + i];
      sumSq += s * s;
      if (i > 0) {
        const prev = samples[offset + i - 1];
        if ((s >= 0 && prev < 0) || (s < 0 && prev >= 0)) {
          zeroCrossings += 1;
        }
      }
    }

    const rms = Math.sqrt(sumSq / FFT_SIZE);
    if (rms < SILENCE_RMS_THRESHOLD) {
      continue;
    }

    activeFrames += 1;

    const re = new Float64Array(FFT_SIZE);
    const im = new Float64Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i += 1) {
      re[i] = samples[offset + i] * HAMMING_WINDOW[i];
    }

    fftRadix2(re, im);

    let totalMag = 0;
    let weightedFreqSum = 0;

    for (let b = 0; b < NUM_BANDS; b += 1) {
      let bandEnergy = 0;
      const startBin = b * binsPerBand;
      const endBin = b === NUM_BANDS - 1 ? halfFft : startBin + binsPerBand;
      for (let k = startBin; k < endBin; k += 1) {
        const mag = Math.hypot(re[k], im[k]);
        bandEnergy += mag;
        totalMag += mag;
        weightedFreqSum += k * mag;
      }
      accumBands[b] += bandEnergy / (endBin - startBin);
    }

    const centroidNorm = totalMag > 0 ? weightedFreqSum / (totalMag * halfFft) : 0;
    const zcrNorm = zeroCrossings / (FFT_SIZE - 1);

    accumCentroid += centroidNorm;
    accumZcr += zcrNorm;
  }

  if (activeFrames === 0) {
    return {
      vector: new Array(NUM_BANDS + 2).fill(0),
      activeFrames: 0,
      totalFrames,
    };
  }

  const rawVector = new Array(NUM_BANDS + 2);
  for (let b = 0; b < NUM_BANDS; b += 1) {
    rawVector[b] = accumBands[b] / activeFrames;
  }
  rawVector[NUM_BANDS] = accumCentroid / activeFrames;
  rawVector[NUM_BANDS + 1] = accumZcr / activeFrames;

  // Normalización L2
  let normSq = 0;
  for (let i = 0; i < rawVector.length; i += 1) {
    normSq += rawVector[i] * rawVector[i];
  }
  const norm = Math.sqrt(normSq);
  const vector =
    norm > 0 ? rawVector.map((v) => v / norm) : new Array(NUM_BANDS + 2).fill(0);

  return {
    vector,
    activeFrames,
    totalFrames,
  };
}

function cosineSimilarityPercent(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i += 1) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) {
    return 0;
  }

  const clamped = Math.max(0, Math.min(1, dot / denom));
  return Number((clamped * 100).toFixed(2));
}

function compareVoiceBuffers(sampleBuffer, baselineBuffer, threshold) {
  const effectiveThreshold = Number.isFinite(Number(threshold))
    ? Number(threshold)
    : Number(process.env.VOICE_SIMILARITY_THRESHOLD) || 70;

  const sampleSig = extractVoiceSignature(sampleBuffer);
  const baselineSig = extractVoiceSignature(baselineBuffer);

  if (sampleSig.activeFrames === 0 || baselineSig.activeFrames === 0) {
    return {
      similitud_espectro: 0,
      voz_valida: 0,
      sampleActiveFrames: sampleSig.activeFrames,
      baselineActiveFrames: baselineSig.activeFrames,
      threshold: effectiveThreshold,
    };
  }

  const similitud_espectro = cosineSimilarityPercent(sampleSig.vector, baselineSig.vector);
  const voz_valida = similitud_espectro >= effectiveThreshold ? 1 : 0;

  return {
    similitud_espectro,
    voz_valida,
    sampleActiveFrames: sampleSig.activeFrames,
    baselineActiveFrames: baselineSig.activeFrames,
    threshold: effectiveThreshold,
  };
}

module.exports = {
  FFT_SIZE,
  NUM_BANDS,
  fftRadix2,
  extractVoiceSignature,
  cosineSimilarityPercent,
  compareVoiceBuffers,
};
