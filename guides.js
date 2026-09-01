'use strict';
/* Built-in technique guides (shown via the ⓘ links) */
const HELP = {
  original: ['The pristine viewer.', 'Hover shows a 26-pixel-wide circular magnifier sampling always from the untouched original - useful for checking edges at pixel level.', 'Ctrl+wheel zooms at the cursor.'],
  ela: ['What it does: re-saves the image as JPEG at a chosen quality and amplifies the pixel difference. Regions edited after the last save react differently than untouched regions.', 'Normal: uniformly dark/slightly speckled surface, similarly bright high-contrast edges everywhere.', 'Suspicious: flat surfaces glowing much brighter than neighbouring surfaces, or object-level brightness differences.', 'Limits: platform re-compression flattens ELA; naturally textured areas look bright. Indicators, not proof.'],
  gradient: ['Shows horizontal+vertical luminance change magnitude.', 'Normal: smooth falloff, consistent edge energy across the frame.', 'Suspicious: cut-out objects surrounded by abrupt gradient rings, lighting direction that conflicts between regions.'],
  noise: ['High-pass residual (pixel minus local mean) visualises sensor/grain noise.', 'Normal: one consistent texture across same-exposure areas.', 'Suspicious: smooth dead patches inside detailed regions, mismatched grain between regions, cloned-looking repeats.'],
  bits: ['Displays a single bit of one channel.', 'Bit 0 (LSB) patterns can reveal pasted content, watermark remnants or simple LSB steganography.', 'Random noise-like LSBs are normal for photos; structured shapes deserve attention.'],
  ghost: ['JPEG Ghost re-encodes the image at many quality levels (40-95) and records which quality each pixel matches best.', 'Normal: one dominant quality (the last save) covering nearly the whole image.', 'Suspicious: a second cluster of regions consistently matching a DIFFERENT quality - those areas were likely edited and saved in an earlier cycle.', 'Limits: heavy platform recompression washes ghosts out.'],
  cmfd: ['Copy-Move detection finds duplicated patches inside the same image (cloning to hide or add content).', 'It normalises 8x8 blocks, matches them under translation, and keeps only offset-consistent clusters - this suppresses false positives from textures.', 'Suspicious: two or more sizeable clusters with a single shared offset vector.', 'Limits: rotated/resized/scaled clones are missed; large uniform textures can false-positive.'],
  prnu: ['PRNU (Photo Response Non-Uniformity) is the sensor\u2019s fingerprint noise. The image is divided into cells and neighbouring cells\u2019 residuals are correlated.', 'Normal: fairly uniform correlation across the frame.', 'Suspicious: isolated cells with much weaker correlation - possibly spliced from another source.', 'Limits: needs reasonably uncompressed originals; heavy JPEG or social media re-encodes destroy PRNU.'],
  freq: ['FFT power spectrum (log-scaled, DC centered).', 'Normal: smooth radial decay (natural images follow a power law).', 'Suspicious: isolated bright spots off-center (periodic patterns), unusual spikes along axes (synthetic grids), ring artifacts (heavy upsampling).'],
  deepfake: ['Heuristic AI-artifact screen of the CENTER region: spectral slope, angular anisotropy, chroma over-smoothness and micro-texture balance.', 'This is NOT neural-network based and cannot recognise specific models. High scores mean "worth a closer look", nothing more.', 'Always corroborate with reverse-image search and provenance.'],
  resamp: ['Detects interpolation traces: the Laplacian signal is autocorrelated along rows/columns; periodic peaks at lags other than the JPEG grid indicate prior resizing.', 'Suspicious: prominence peaks at arbitrary lags in both directions.', 'Limits: JPEG\u2019s own 8px grid is excluded; strong sharpening can mimic weak signals.'],
  stego: ['Chi-square attack on LSB pairs: in natural images, histogram neighbours 2i/2i+1 differ; LSB embedding equalises them, driving chi-square p-values toward 1.', 'Readout: sustained p>0.5 across most sequential chunks suggests embedded data. The stage view tints suspicious blocks red over the LSB plane.', 'Also check the Bit Planes tool visually.'],
  quant: ['Compares the file\u2019s quantization tables against the standard IJG scaling curve to estimate the encoder quality and flag anomalies like distinct luma/chroma qualities (possible double compression).']
};

const GUIDE_TITLES = {
  original: 'Original viewer & magnifier',
  ela: 'Error Level Analysis (ELA)',
  gradient: 'Luminance Gradient',
  noise: 'Noise / High-Pass residual',
  bits: 'Bit Planes',
  ghost: 'JPEG Ghost \u2014 multi-quality history',
  cmfd: 'Copy-Move / clone detection',
  prnu: 'PRNU sensor-noise consistency',
  freq: 'Frequency (FFT) analysis',
  deepfake: 'Deepfake / AI-artifact heuristics',
  resamp: 'Resampling detection',
  stego: 'LSB steganalysis (chi-square)',
  quant: 'Quantization table analysis'
};
