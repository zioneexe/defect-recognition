import { ChangeDetectorRef, Component, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ImageAsset, DatasetImage, ImageClass, sampleDataset, generateImage, loadImage, pixels, decode } from './images';
import { bitmap, download } from './export';

interface Defect { index: number; x: number; y: number; cell: number; cells: number[]; row: number; col: number; intensity: number; area: number; anomalyScore: number; contribution: number; bounds: { x: number; y: number; width: number; height: number }; gridBounds: { rowStart: number; rowEnd: number; colStart: number; colEnd: number }; }
interface Result { grid: number[]; defects: Defect[]; score: number; confidence: number; classification: string; localizationStatus: 'localized' | 'failed' | 'not-needed'; elapsed: number; }
@Component({ selector: 'app-root', imports: [CommonModule, FormsModule], templateUrl: './app.html', styleUrl: './app.css' })
export class App implements OnDestroy {
  images = sampleDataset(); shapes = ['Circle', 'Square']; groups = ['HighQuality', 'Icons']; classes: ImageClass[] = ['Clean', 'Defective'];
  selected = 'Circle/HighQuality'; expanded = new Set(['Assets', 'Circle', 'Circle/HighQuality']);
  epochs = 100; learningRate = .05; epoch = 0; prepared = 0; totalImages = 0; loss: number | null = null; accuracy: number | null = null; elapsed = 0;
  training = false; recognizing = false; loading = false; trained = false; status = 'Not trained'; progress = 0;
  inputImage?: ImageAsset; result?: Result; defectIndex = 0; format = 'PNG';
  logs: { time: string; text: string; kind: string }[] = []; autoScroll = true;
  modal = ''; shapeName = ''; imageClass: ImageClass = 'Defective'; info?: ImageAsset; error = '';
  uploadShape = 'Circle'; uploadGroup = 'HighQuality'; validationCount = 0;
  private recognitionStarted = 0; private trainingStarted = 0;
  private worker?: Worker;
  constructor(private cdr: ChangeDetectorRef) { this.log('Sample dataset loaded: 250 generated images.'); this.log('Select a training scope, then start training.'); }
  ngOnDestroy() { this.worker?.terminate(); }
  get scope(): DatasetImage[] { return this.images.filter(image => this.selected === 'Assets' || this.selected === image.shape || this.selected === `${image.shape}/${image.group}` || this.selected === `${image.shape}/${image.group}/${image.imageClass}`); }
  get scopeName() { return this.selected.replaceAll('/', ' / '); }
  get defect() { return this.result?.defects[this.defectIndex]; }
  get busy() { return this.training || this.recognizing || this.loading; }
  count(shape: string, group?: string, imageClass?: ImageClass) { return this.images.filter(image => image.shape === shape && (!group || image.group === group) && (!imageClass || image.imageClass === imageClass)).length; }
  children(shape: string, group: string, imageClass: ImageClass) { return this.images.filter(image => image.shape === shape && image.group === group && image.imageClass === imageClass); }
  toggle(key: string) { this.expanded.has(key) ? this.expanded.delete(key) : this.expanded.add(key); }
  select(key: string) { if (!this.training) this.selected = key; }
  log(text: string, kind = '') {
    this.logs.push({ time: new Date().toLocaleTimeString('en-GB'), text, kind });
    if (this.logs.length > 500) this.logs.shift();
    if (this.autoScroll) setTimeout(() => { const el = document.getElementById('log-lines'); if (el) el.scrollTop = el.scrollHeight; });
  }
  fail(message: string) { this.error = message; this.log(message, 'error'); this.cdr.markForCheck(); }
  addShape() { const name = this.shapeName.trim(); if (!name || name.includes('/') || this.shapes.includes(name)) return; this.shapes.push(name); this.selected = name; this.expanded.add(name); this.shapeName = ''; this.modal = ''; this.log(`Shape added: ${name}.`); }
  resetResult() { this.result = undefined; this.progress = 0; this.defectIndex = 0; }
  invalidateModel() { this.worker?.terminate(); this.worker = undefined; this.trained = false; this.status = 'Not trained'; this.epoch = this.prepared = this.totalImages = this.elapsed = 0; this.loss = this.accuracy = null; this.validationCount = 0; this.resetResult(); }
  clearDataset() { this.images = []; this.selected = 'Assets'; this.modal = ''; this.invalidateModel(); this.log('Dataset cleared.'); }
  restoreSamples() { this.images = sampleDataset(); this.shapes = ['Circle', 'Square']; this.selected = 'Circle/HighQuality'; this.invalidateModel(); this.log('Sample dataset restored: 250 images.'); }
  useImage(image: DatasetImage) { if (this.busy) return; this.inputImage = image.asset || generateImage(image); this.resetResult(); this.log(`Input image loaded: ${this.inputImage.name}.`); }
  openImport() { const [shape, group, imageClass] = this.selected.split('/'); this.uploadShape = this.shapes.includes(shape) ? shape : this.shapes[0]; this.uploadGroup = group || 'HighQuality'; this.imageClass = imageClass === 'Clean' ? 'Clean' : 'Defective'; this.modal = 'images'; }
  async upload(event: Event, target: 'recognition' | 'dataset') {
    const input = event.target as HTMLInputElement, files = Array.from(input.files || []); input.value = '';
    if (!files.length || this.busy) return;
    this.error = ''; this.loading = true;
    try {
      if (target === 'recognition') {
        if (files.length !== 1) throw Error('Choose one PNG, JPG or BMP image.');
        this.inputImage = await loadImage(files[0]); this.resetResult(); this.log(`Input image loaded: ${this.inputImage.name}.`);
      } else {
        const assets = await Promise.all(files.map(loadImage));
        let id = this.images.reduce((max, image) => Math.max(max, image.id), 0);
        for (const asset of assets) this.images.push({ id: ++id, shape: this.uploadShape, group: this.uploadGroup, imageClass: this.imageClass, asset });
        this.invalidateModel(); this.log(`Added ${assets.length} ${this.imageClass} images to ${this.uploadShape} / ${this.uploadGroup}.`); this.modal = '';
      }
    } catch (e) { this.fail((e as Error).message); }
    this.loading = false; this.cdr.markForCheck();
  }
  createWorker() {
    this.worker?.terminate(); this.worker = new Worker('engine/worker.js');
    this.worker.onerror = (e) => { this.training = this.recognizing = this.trained = false; this.status = 'Not trained'; this.fail(e.message || 'Worker failed to load.'); };
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'prepared') this.prepared = data.count;
      if (data.type === 'mode') { this.status = 'Training in progress'; this.log(`Image preparation completed: ${this.prepared} / ${this.totalImages}. Training on ${data.mode}.`); }
      if (data.type === 'epoch') { this.epoch = data.epoch; this.loss = data.loss; this.elapsed = performance.now() - this.trainingStarted; if (data.epoch === 1 || data.epoch % 10 === 0) this.log(`Epoch ${data.epoch}/${this.epochs} · loss ${data.loss.toFixed(5)}.`); }
      if (data.type === 'trained') { this.training = false; this.trained = true; this.status = 'Training completed'; this.epoch = data.epoch; this.loss = data.loss; this.accuracy = data.accuracy; this.validationCount = data.validationCount; this.elapsed = performance.now() - this.trainingStarted; this.log(`Training completed · validation accuracy ${(data.accuracy * 100).toFixed(1)}% (${data.validationCount} images).`, 'success'); }
      if (data.type === 'recognitionProgress') this.progress = data.progress;
      if (data.type === 'recognized') { this.result = { ...data, elapsed: performance.now() - this.recognitionStarted }; this.recognizing = false; this.progress = 100; this.defectIndex = 0; this.log(data.localizationStatus === 'failed' ? 'Defect detected, but localization failed.' : `Input image recognition completed in ${this.result!.elapsed.toFixed(1)} ms · ${data.classification} · Detected regions: ${data.defects.length}.`, data.localizationStatus === 'failed' ? 'error' : 'success'); }
      if (data.type === 'error') { this.training = this.recognizing = false; this.status = this.trained ? 'Training completed' : 'Training failed'; this.fail(data.message); }
      this.cdr.markForCheck();
    };
  }
  async train() {
    if (this.busy) return;
    if (!Number.isInteger(this.epochs) || this.epochs < 1 || this.epochs > 5000 || !Number.isFinite(this.learningRate) || this.learningRate <= 0 || this.learningRate > 1) { this.fail('Use 1–5000 epochs and a learning rate greater than 0 and at most 1.'); return; }
    if (this.classes.some(imageClass => this.scope.filter(image => image.imageClass === imageClass).length < 2)) { this.fail('Select at least two Clean and two Defective images for training and validation.'); return; }
    this.error = ''; this.training = true; this.trained = false; this.result = undefined; this.epoch = 0; this.prepared = 0; this.loss = this.accuracy = null; this.elapsed = 0;
    this.resetResult(); this.trainingStarted = performance.now();
    this.status = 'Preparing images'; const scope = [...this.scope]; this.totalImages = scope.length;
    this.createWorker(); this.log(`Training started: ${this.scopeName} · ${scope.length} images.`);
    try {
      const images = [];
      for (const image of scope) {
        const normalized = await pixels(image.asset || generateImage(image));
        images.push({ pixels: normalized, imageClass: image.imageClass });
      }
      this.worker!.postMessage({ type: 'train', images, epochs: this.epochs, learningRate: this.learningRate }, images.map(image => image.pixels.buffer));
    } catch (e) { this.training = false; this.status = 'Training failed'; this.fail((e as Error).message); }
  }
  async recognize() {
    if (!this.inputImage || !this.trained || this.busy) return;
    this.error = ''; this.resetResult(); this.recognizing = true; this.recognitionStarted = performance.now();
    try { const normalized = await pixels(this.inputImage); this.progress = 25; this.cdr.markForCheck(); this.worker!.postMessage({ type: 'recognize', pixels: normalized, width: this.inputImage.width, height: this.inputImage.height }, [normalized.buffer]); }
    catch (e) { this.recognizing = false; this.fail((e as Error).message); }
  }
  navigate(delta: number) { if (!this.result?.defects.length) return; this.selectDefect((this.defectIndex + delta + this.result.defects.length) % this.result.defects.length); }
  selectDefect(index: number) { this.defectIndex = index; this.log(`Defect ${index + 1} of ${this.result!.defects.length} selected.`); }
  selectCell(cell: number) { const index = this.result?.defects.findIndex(region => region.cells.includes(cell)) ?? -1; if (index >= 0) this.selectDefect(index); }
  isSuspicious(cell: number) { return this.result?.defects.some(region => region.cells.includes(cell)) ?? false; }
  location(axis: 'x' | 'y') { return this.defect ? this.defect[axis] : '—'; }
  cellColor(value: number, index: number) { return this.defect?.cells.includes(index) ? '#f14d73' : `rgba(66, 145, 245, ${.05 + value * .95})`; }
  async saveImage() {
    if (!this.result || !this.inputImage) return;
    const image = await decode(this.inputImage.url), canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const c = canvas.getContext('2d')!; c.fillStyle = '#fff'; c.fillRect(0,0,canvas.width,canvas.height); c.drawImage(image, 0, 0);
    c.strokeStyle = '#f14d73'; c.lineWidth = Math.max(2, image.width / 200);
    this.result.defects.forEach(d => { c.fillStyle = '#f14d7326'; c.fillRect(d.bounds.x, d.bounds.y, d.bounds.width, d.bounds.height); c.strokeRect(d.bounds.x, d.bounds.y, d.bounds.width, d.bounds.height); });
    const ext = this.format.toLowerCase();
    if (ext === 'bmp') download(bitmap(canvas), 'defect-result.bmp');
    else { const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, ext === 'jpg' ? 'image/jpeg' : 'image/png', .95)); if (blob) download(blob, `defect-result.${ext}`); }
    this.log(`Saved annotated result image (${this.format}).`);
  }
  saveResult() { if (!this.result) return; download(new Blob([JSON.stringify({ ...this.result, gridSize: 10, processingSize: 200, coordinateSystem: 'Original image pixels; grid rows and columns are 1-based', inputImage: this.inputImage?.name, originalWidth: this.inputImage?.width, originalHeight: this.inputImage?.height, validationAccuracy: this.accuracy }, null, 2)], { type: 'application/json' }), 'defect-result.json'); this.log('Saved input image recognition result (JSON).'); }
}
