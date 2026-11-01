import { ChangeDetectorRef, Component, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ImageAsset, DatasetImage, ImageClass, SHAPES, GROUPS, SAMPLE_VERSION, sampleDataset, imageName, generateImage, renderImage, release, loadImage, urlAsset, normalize, decode, fieldImage } from './images';
import { Listing, FolderMeta, fileUrl, listDataset, readMeta, writeMeta, writeImage, makeFolder, removeImages, watchDataset, openFolder as showFolder } from './dataset';
import { bitmap, download } from './export';

interface Defect { index: number; x: number; y: number; cell: number; cells: number[]; row: number; col: number; intensity: number; area: number; anomalyScore: number; contribution: number; bounds: { x: number; y: number; width: number; height: number }; gridBounds: { rowStart: number; rowEnd: number; colStart: number; colEnd: number }; }
interface Result { grid: number[]; defects: Defect[]; score: number; confidence: number; classification: string; localizationStatus: 'localized' | 'failed' | 'not-needed'; elapsed: number; referenceMethod: string; referenceUrl: string; differenceUrl: string; }
type View = 'Input' | 'Reference' | 'Difference';
interface TrainingStats {
  mode: string; features: number;
  preparation: { images: number; wall: number; load: number; difference: number; parallelLoads: number };
  training: { time: number; epochs: number; images: number; inputs: number };
  validation: { time: number; confusion: { tp: number; tn: number; fp: number; fn: number }; byGroup: Record<string, { accuracy: number; count: number }>; byShape: Record<string, { accuracy: number; count: number }> };
}
const ms = (value: number) => `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ms`, seconds = (value: number) => `${(value / 1000).toFixed(1)} s`;
// Diverging palette for input − reference over the dark panel: brighter → amber, darker → cyan.
const BASE = [8, 14, 29], BRIGHTER = [255, 196, 61], DARKER = [74, 195, 255];
const tone = (value: number, gain: number) => { const a = Math.min(1, Math.abs(value) * gain), to = value >= 0 ? BRIGHTER : DARKER; return BASE.map((base, i) => Math.round(base + (to[i] - base) * a)) as [number, number, number]; };
@Component({ selector: 'app-root', imports: [CommonModule, FormsModule], templateUrl: './app.html', styleUrl: './app.css' })
export class App implements OnDestroy {
  images: DatasetImage[] = sampleDataset(); shapes = [...SHAPES]; groups = [...GROUPS]; private folders: Record<string, string[]> = {}; classes: ImageClass[] = ['Clean', 'Defective'];
  selected = new Set(['Circle/HighQuality']); expanded = new Set(['Assets', 'Circle', 'Circle/HighQuality']);
  epochs = 100; learningRate = .05; epoch = 0; prepared = 0; totalImages = 0; loss: number | null = null; accuracy: number | null = null; elapsed = 0;
  training = false; recognizing = false; loading = false; trained = false; status = 'Not trained'; progress = 0;
  inputImage?: ImageAsset; result?: Result; defectIndex = 0; format = 'PNG'; gridSize = 20;
  views: View[] = ['Input', 'Reference', 'Difference']; view: View = 'Input';
  logs: { time: string; text: string; kind: string }[] = []; autoScroll = true;
  modal = ''; shapeName = ''; imageClass: ImageClass = 'Defective'; info?: ImageAsset; error = '';
  uploadShape = 'Circle'; uploadGroup = 'HighQuality'; validationCount = 0;
  // Dataset folder (server/dataset.mjs) when connected; empty while the dataset lives in memory.
  folder = ''; generating = false; written = 0; missingSamples = 0; private inputPath?: string;
  private stopWatching?: () => void; private syncing = false; private chain = Promise.resolve(); private queued?: Promise<void>;
  private recognitionStarted = 0; private trainingStarted = 0;
  private worker?: Worker;
  constructor(private cdr: ChangeDetectorRef) { this.connect(); }
  ngOnDestroy() { this.worker?.terminate(); this.stopWatching?.(); }
  async connect() {
    try {
      const listed = performance.now(), listing = await listDataset();
      this.folder = listing.root; this.apply(listing);
      // While the app itself writes or removes files it refreshes on its own schedule.
      this.stopWatching = watchDataset(() => { if (!this.syncing) this.sync(); });
      this.log(`Dataset folder ${listing.root}: ${listing.images.length} images${listing.ignored ? `, ${listing.ignored} entries outside Shape/Group/Clean|Defective ignored` : ''}, listed in ${ms(performance.now() - listed)}. Watching for changes.`);
      // Saved images are reused as they are. Generated images are written only into a brand-new folder,
      // to finish an interrupted run, or once when the generator changed; an emptied folder stays empty.
      const meta = await readMeta(), samples = new Set(sampleDataset().map(item => this.samplePath(item)));
      const outdated = (meta.sampleVersion ?? 1) < SAMPLE_VERSION && listing.images.some(image => samples.has(image.path));
      if (!listing.shapes.length || meta.samples === 'writing' || outdated) this.generateSamples(meta);
    } catch { this.log(`Dataset folder unavailable (start with npm start); using ${this.images.length} generated images in memory.`); }
    this.log('Select a training scope, then start training.');
    this.cdr.markForCheck();
  }
  // Folder listings are applied one after another, so an older listing never overwrites a newer one.
  sync(quiet = false): Promise<void> {
    if (this.queued && !quiet) return this.queued;
    return this.queued = this.chain = this.chain.then(() => { this.queued = undefined; return this.load(quiet); });
  }
  private async load(quiet: boolean) {
    try {
      const [added, removed] = this.apply(await listDataset());
      if (!quiet && !this.syncing && (added || removed)) this.log(`Dataset folder changed: ${added} added, ${removed} removed.${this.trained ? ' Retrain to include the changes.' : ''}`);
    } catch (e) { this.fail(`Dataset folder unavailable: ${(e as Error).message}`); }
    this.cdr.markForCheck();
  }
  /** Replaces the tree with the folder listing, keeping ids of unchanged files. Returns [added, removed]. */
  private apply(listing: Listing) {
    const known = new Map(this.images.filter(image => image.path).map(image => [image.path!, image]));
    let id = this.images.reduce((max, image) => Math.max(max, image.id), 0), added = 0;
    this.images = listing.images.map(file => {
      const previous = known.get(file.path);
      if (previous) known.delete(file.path); else added++;
      return previous && previous.modified === file.modified && previous.size === file.size ? previous : { id: previous?.id ?? ++id, shape: file.shape, group: file.group, imageClass: file.imageClass, path: file.path, size: file.size, modified: file.modified };
    });
    this.shapes = [...SHAPES.filter(shape => listing.shapes.includes(shape)), ...listing.shapes.filter(shape => !SHAPES.includes(shape)).sort()];
    this.groups = [...GROUPS, ...listing.groups.filter(group => !GROUPS.includes(group)).sort()]; this.folders = listing.folders || {};
    // Folders removed on disk leave the selection; with nothing left, the whole dataset is selected.
    const kept = [...this.selected].filter(key => { const [shape, group] = key.split('/'); return key === 'Assets' || this.shapes.includes(shape) && (!group || this.groupsOf(shape).includes(group)); });
    if (kept.length !== this.selected.size) {
      const gone = [...this.selected].filter(key => !kept.includes(key)).map(key => key.replaceAll('/', ' / '));
      this.selected = new Set(kept.length ? kept : ['Assets']);
      this.log(`${gone.join(', ')} no longer in the dataset folder; training selection is now ${this.scopeName}.`);
    }
    const paths = new Set(listing.images.map(image => image.path));
    this.missingSamples = sampleDataset().filter(item => !paths.has(this.samplePath(item))).length;
    if (this.inputPath && !paths.has(this.inputPath)) { this.log(`Input image ${this.inputImage?.name} was removed from the dataset folder; it stays loaded for recognition.`); this.inputPath = undefined; }
    return [added, known.size];
  }
  get trash() { const separator = this.folder.includes('\\') ? '\\' : '/'; return `${this.folder}${separator}.removed`; }
  samplePath(item: DatasetImage) { return `${item.shape}/${item.group}/${item.imageClass}/${imageName(item)}`; }
  /** Opens the selected folder in the file manager; the dataset root when several or Assets are selected. */
  async openFolder() {
    const [key] = this.selected, target = this.selected.size === 1 && key !== 'Assets' ? key : '';
    try { await showFolder(target); this.log(`Opened ${target ? target.replaceAll('/', ' / ') : 'the dataset folder'} in the file manager.`); }
    catch (e) { this.fail((e as Error).message); }
  }
  /**
   * Renders the generated sample dataset into the folder as PNG files, four writes at a time. Missing files are
   * always written. When the folder was written by an older generator (`rewrite`), existing generated files are
   * rewritten too, except those this run already wrote (modified after `started`). The run is recorded in the
   * folder's notes, so an interrupted run continues where it stopped.
   */
  async generateSamples(meta: FolderMeta = {}) {
    if (this.busy || !this.folder) return;
    const all = sampleDataset(), path = (item: DatasetImage) => this.samplePath(item), saved = new Map(this.images.map(image => [image.path, image]));
    const resuming = meta.samples === 'writing' && meta.sampleVersion === SAMPLE_VERSION;
    const rewrite = resuming ? !!meta.rewrite : (meta.sampleVersion ?? 1) < SAMPLE_VERSION, started = (resuming && meta.started) || Date.now();
    const items = all.filter(item => { const file = saved.get(path(item)); return !file || rewrite && (file.modified ?? 0) < started; });
    if (!items.length) { await writeMeta({ sampleVersion: SAMPLE_VERSION, samples: 'complete' }).catch(() => {}); return; }
    const rewriting = items.filter(item => saved.has(path(item))).length;
    if (rewriting) this.log(`Sample generator updated to version ${SAMPLE_VERSION}: rewriting ${rewriting} generated images; images you added are kept.`);
    // Images left per Shape / Group / Class folder, to log each folder as it completes.
    const left = new Map<string, number>(), folder = (item: DatasetImage) => `${item.shape} / ${item.group} / ${item.imageClass}`;
    for (const item of items) left.set(folder(item), (left.get(folder(item)) || 0) + 1);
    let next = 0, failure: Error | undefined;
    const timer = performance.now(), resumedFrom = all.length - items.length;
    this.generating = this.syncing = true; this.written = all.length - items.length; this.invalidateModel();
    await writeMeta({ sampleVersion: SAMPLE_VERSION, samples: 'writing', started, rewrite }).catch(() => {});
    this.log(items.length === all.length ? `Writing ${all.length} generated PNG images to ${this.folder}…`
      : resuming ? `Continuing the sample dataset: ${items.length} of ${all.length} PNG images still to write in ${this.folder}…`
      : `Restoring ${items.length} missing generated images in ${this.folder}…`);
    const cost = { render: 0, write: 0, bytes: 0, count: 0 };
    const progress = (item: DatasetImage, data: { render: number; write: number; size: number }) => {
      this.written++; cost.render += data.render; cost.write += data.write; cost.bytes += data.size; cost.count++;
      const remaining = left.get(folder(item))! - 1; left.set(folder(item), remaining);
      if (!remaining) this.log(`Generated ${folder(item)}: ${all.filter(other => folder(other) === folder(item)).length} images.`);
      if (this.written % 500 === 0) {
        const rate = (this.written - resumedFrom) / ((performance.now() - timer) / 1000);
        this.log(`Generating images: ${this.written} / ${all.length} · ${rate.toFixed(0)} images/s · about ${Math.ceil((all.length - this.written) / rate)} s left.`);
      }
      if (this.written % 250 === 0) this.sync(true);
      this.cdr.markForCheck();
    };
    // Web workers render and write the images: unlike the page they keep full speed in a background tab,
    // and each one runs on its own core. Each worker takes the next image as soon as it finishes one.
    const pool = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    await new Promise<void>(done => {
      let active = pool;
      const feed = (worker: Worker) => {
        if (failure || next >= items.length) { worker.terminate(); if (--active === 0) done(); return; }
        const item = items[next++];
        worker.onmessage = ({ data }) => { if (data.error) failure ||= Error(data.error); else progress(item, data); feed(worker); };
        worker.postMessage({ item: { id: item.id, shape: item.shape, group: item.group, imageClass: item.imageClass }, path: path(item) });
      };
      for (let i = 0; i < pool; i++) {
        const worker = new Worker(new URL('./generator.worker', import.meta.url), { type: 'module' });
        worker.onerror = event => { failure ||= Error(event.message || 'Image generator worker failed to load.'); worker.terminate(); if (--active === 0) done(); };
        feed(worker);
      }
    });
    if (failure) this.fail(`Writing the sample dataset stopped at ${this.written} / ${all.length}: ${failure.message} Reload the page or use Restore below the tree to continue.`);
    else { await writeMeta({ sampleVersion: SAMPLE_VERSION, samples: 'complete' }).catch(() => {}); this.log(`Sample dataset written: ${all.length} images${items.length ? ` (${items.length} generated in ${((performance.now() - timer) / 1000).toFixed(1)} s)` : ''}.`, 'success'); }
    if (cost.count) {
      const seconds = (performance.now() - timer) / 1000;
      this.log(`Benchmark · generation: ${cost.count} images in ${seconds.toFixed(1)} s with ${pool} web workers = ${(cost.count / seconds).toFixed(1)} images/s · per image in a worker: render and PNG encoding ${ms(cost.render / cost.count)}, writing ${ms(cost.write / cost.count)} · average PNG ${(cost.bytes / cost.count / 1024).toFixed(0)} KB.`, 'benchmark');
    }
    this.generating = this.syncing = false; await this.sync(true);
  }
  // Union of every selected folder; an image inside two selected folders counts once.
  get scope(): DatasetImage[] { const keys = [...this.selected]; return this.images.filter(image => keys.some(key => key === 'Assets' || key === image.shape || key === `${image.shape}/${image.group}` || key === `${image.shape}/${image.group}/${image.imageClass}`)); }
  get scopeName() { return [...this.selected].map(key => key.replaceAll('/', ' / ')).join(', '); }
  /** A folder inside another selected folder: already part of the training scope. */
  included(key: string) { return [...this.selected].some(other => other !== key && (other === 'Assets' || key.startsWith(other + '/'))); }
  get defect() { return this.result?.defects[this.defectIndex]; }
  get previewUrl() { return this.view === 'Reference' ? this.result!.referenceUrl : this.view === 'Difference' ? this.result!.differenceUrl : this.inputImage!.url; }
  get caption() {
    if (this.view === 'Reference') return 'Reference: defect-free estimate of the input';
    if (this.view === 'Difference') return 'Input − reference · amber brighter, cyan darker';
    const d = this.defect;
    return d ? `${d.cells.length} ${d.cells.length === 1 ? 'cell' : 'cells'} selected · X ${d.bounds.x} / Y ${d.bounds.y}` : 'No defect regions';
  }
  get busy() { return this.training || this.recognizing || this.loading || this.generating; }
  count(shape: string, group?: string, imageClass?: ImageClass) { return this.images.filter(image => image.shape === shape && (!group || image.group === group) && (!imageClass || image.imageClass === imageClass)).length; }
  name(image: DatasetImage) { return imageName(image); }
  /** Tree groups of a shape: the standard ones plus any other group folder that shape actually has. */
  groupsOf(shape: string) { return [...GROUPS, ...(this.folders[shape] || []).filter(group => !GROUPS.includes(group)).sort()]; }
  children(shape: string, group: string, imageClass: ImageClass) { return this.images.filter(image => image.shape === shape && image.group === group && image.imageClass === imageClass); }
  toggle(key: string) { this.expanded.has(key) ? this.expanded.delete(key) : this.expanded.add(key); }
  // Ctrl/⌘+click adds or removes a folder; a plain click selects only that folder.
  select(key: string, event?: MouseEvent) {
    if (this.training) return;
    if (!event?.ctrlKey && !event?.metaKey) this.selected = new Set([key]);
    else if (this.included(key)) return;
    else if (!this.selected.has(key)) {
      // A folder absorbs its selected subfolders, so the selection never lists one inside another.
      for (const other of this.selected) if (key === 'Assets' || other.startsWith(key + '/')) this.selected.delete(other);
      this.selected.add(key);
    }
    else if (this.selected.size > 1) this.selected.delete(key);
  }
  log(text: string, kind = '') {
    this.logs.push({ time: new Date().toLocaleTimeString('en-GB'), text, kind });
    if (this.logs.length > 2000) this.logs.shift();
    if (this.autoScroll) setTimeout(() => { const el = document.getElementById('log-lines'); if (el) el.scrollTop = el.scrollHeight; });
  }
  fail(message: string) { this.error = message; this.log(message, 'error'); this.cdr.markForCheck(); }
  // 'Assets' is the tree root's key, so a shape with that name would select the whole dataset.
  validShape(name: string) { const n = name.trim().toLowerCase(); return !!n && !n.includes('/') && n !== 'assets' && !this.shapes.some(shape => shape.toLowerCase() === n); }
  addShape() {
    const name = this.shapeName.trim(); if (!this.validShape(name)) return;
    if (this.folder) makeFolder(name).then(() => this.sync(true), e => this.fail((e as Error).message));
    this.shapes.push(name); this.selected = new Set([name]); this.expanded.add(name); this.shapeName = ''; this.modal = ''; this.log(`Shape added: ${name}.`);
  }
  resetResult() { this.result = undefined; this.progress = 0; this.defectIndex = 0; }
  invalidateModel() { this.worker?.terminate(); this.worker = undefined; this.trained = false; this.status = 'Not trained'; this.epoch = this.prepared = this.totalImages = this.elapsed = 0; this.loss = this.accuracy = null; this.validationCount = 0; this.resetResult(); }
  async clearDataset() {
    const removed = new Set(this.scope), name = this.scopeName;
    if (this.folder) {
      this.modal = ''; this.syncing = true;
      try { const moved = await removeImages([...removed].filter(image => image.path).map(image => image.path!)); this.invalidateModel(); this.log(`Moved ${moved} images from ${name} to ${this.trash}.`); }
      catch (e) { this.fail((e as Error).message); }
      this.syncing = false; this.selected = new Set(['Assets']); await this.sync(true);
      return;
    }
    for (const image of removed) if (image.asset?.url.startsWith('blob:') && image.asset !== this.inputImage) URL.revokeObjectURL(image.asset.url);
    this.images = this.images.filter(image => !removed.has(image)); this.selected = new Set(['Assets']); this.modal = ''; this.invalidateModel();
    this.log(`Removed ${removed.size} images from ${name}.`);
  }
  restoreSamples() { if (this.folder) { readMeta().then(meta => this.generateSamples(meta), e => this.fail((e as Error).message)); return; } this.images = sampleDataset(); this.shapes = [...SHAPES]; this.selected = new Set(['Circle/HighQuality']); this.invalidateModel(); this.log(`Sample dataset restored: ${this.images.length} images.`); }
  async useImage(image: DatasetImage) {
    if (this.busy) return;
    try {
      const previous = this.inputImage;
      this.inputImage = image.asset || (image.path ? await urlAsset(fileUrl(image.path), imageName(image)) : await generateImage(image));
      this.inputPath = image.path; this.resetResult(); this.log(`Input image loaded: ${this.inputImage.name}.`);
      if (previous?.url.startsWith('blob:') && !this.images.some(other => other.asset === previous)) URL.revokeObjectURL(previous.url);
    }
    catch (e) { this.fail((e as Error).message); }
    this.cdr.markForCheck();
  }
  openImport() { const [shape, group, imageClass] = [...this.selected][0].split('/'); this.uploadShape = this.shapes.includes(shape) ? shape : this.shapes[0]; this.uploadGroup = group || 'HighQuality'; this.imageClass = imageClass === 'Clean' ? 'Clean' : 'Defective'; this.modal = 'images'; }
  async upload(event: Event, target: 'recognition' | 'dataset') {
    const input = event.target as HTMLInputElement, files = Array.from(input.files || []); input.value = '';
    if (!files.length || this.busy) return;
    this.error = ''; this.loading = true;
    try {
      if (target === 'recognition') {
        if (files.length !== 1) throw Error('Choose one PNG, JPG or BMP image.');
        this.inputImage = await loadImage(files[0]); this.inputPath = undefined; this.resetResult(); this.log(`Input image loaded: ${this.inputImage.name}.`);
      } else {
        // One bad file must not discard the valid ones selected with it.
        const loaded = await Promise.allSettled(files.map(loadImage));
        const assets = loaded.flatMap(result => result.status === 'fulfilled' ? [result.value] : []), rejected = files.filter((_, i) => loaded[i].status === 'rejected').map(file => file.name);
        if (assets.length && this.folder) {
          // The folder keeps the original file bytes; names that already exist get a numeric suffix.
          this.syncing = true;
          try { for (const file of files.filter((_, i) => loaded[i].status === 'fulfilled')) await writeImage(`${this.uploadShape}/${this.uploadGroup}/${this.imageClass}/${file.name}`, file); }
          finally { this.syncing = false; assets.forEach(asset => URL.revokeObjectURL(asset.url)); }
          await this.sync(true); this.invalidateModel(); this.log(`Added ${assets.length} ${this.imageClass} images to ${this.uploadShape} / ${this.uploadGroup}.`); this.modal = '';
        } else if (assets.length) {
          let id = this.images.reduce((max, image) => Math.max(max, image.id), 0);
          for (const asset of assets) this.images.push({ id: ++id, shape: this.uploadShape, group: this.uploadGroup, imageClass: this.imageClass, asset });
          this.invalidateModel(); this.log(`Added ${assets.length} ${this.imageClass} images to ${this.uploadShape} / ${this.uploadGroup}.`); this.modal = '';
        }
        if (rejected.length) this.fail(`Skipped ${rejected.length} unsupported or unreadable ${rejected.length === 1 ? 'file' : 'files'} (PNG, JPG or BMP only): ${rejected.join(', ')}.`);
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
      if (data.type === 'trained') { this.training = false; this.trained = true; this.status = 'Training completed'; this.epoch = data.epoch; this.loss = data.loss; this.accuracy = data.accuracy; this.validationCount = data.validationCount; this.elapsed = performance.now() - this.trainingStarted; this.log(`Training completed · validation accuracy ${(data.accuracy * 100).toFixed(1)}% (${data.validationCount} images).`, 'success'); if (data.stats) this.logTraining(data.stats); }
      if (data.type === 'recognitionProgress') this.progress = data.progress;
      if (data.type === 'recognized') {
        const { reference, difference, type, ...result } = data;
        this.result = { ...result, elapsed: performance.now() - this.recognitionStarted, referenceUrl: fieldImage(reference, value => [value * 255, value * 255, value * 255]), differenceUrl: fieldImage(difference, value => tone(value, 2.5)) };
        this.recognizing = false; this.progress = 100; this.defectIndex = 0;
        this.log(`Reference: ${data.referenceMethod}.`);
        const t = data.timings, roundTrip = this.result!.elapsed;
        if (t) this.log(`Benchmark · recognition of ${this.inputImage?.name} (${this.inputImage?.width}×${this.inputImage?.height}): load and resize ${ms(t.load)}, reference and difference ${ms(t.difference)}, network ${ms(t.network)}, localization ${ms(t.localization)} · ${ms(t.total)} in the worker, ${ms(roundTrip)} from the page (messaging included).`, 'benchmark');
        this.log(data.localizationStatus === 'failed' ? 'Defect detected, but localization failed.' : `Input image recognition completed in ${this.result!.elapsed.toFixed(1)} ms · ${data.classification} · Detected regions: ${data.defects.length}.`, data.localizationStatus === 'failed' ? 'error' : 'success');
      }
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
    this.createWorker(); this.log(`Training started: ${this.scopeName} · ${scope.length} images · features: ${this.gridSize} × ${this.gridSize} grid of input − reference.`);
    try {
      // Files and uploads go to the worker by URL: it loads and reduces them itself, several at a time and at
      // full speed in a background tab. Only images without a file are rendered here, streamed one by one.
      for (const [i, image] of scope.entries()) {
        const url = image.asset?.url || (image.path && fileUrl(image.path));
        const labels = { imageClass: image.imageClass, shape: image.shape, group: image.group };
        if (url) { this.worker!.postMessage({ type: 'sample', url, ...labels }); continue; }
        const rendered = renderImage(image), normalized = normalize(rendered); release(rendered);
        this.worker!.postMessage({ type: 'sample', pixels: normalized, ...labels }, [normalized.buffer]);
        if (i % 25 === 24) await new Promise(resolve => setTimeout(resolve));
      }
      this.worker!.postMessage({ type: 'train', epochs: this.epochs, learningRate: this.learningRate });
    } catch (e) { this.training = false; this.status = 'Training failed'; this.fail((e as Error).message); }
  }
  async recognize() {
    if (!this.inputImage || !this.trained || this.busy) return;
    this.error = ''; this.resetResult(); this.recognizing = true; this.recognitionStarted = performance.now();
    // Recognition reads the image the same way training does: by URL, in the worker.
    try { this.progress = 25; this.cdr.markForCheck(); this.worker!.postMessage({ type: 'recognize', url: this.inputImage.url, width: this.inputImage.width, height: this.inputImage.height }); }
    catch (e) { this.recognizing = false; this.fail((e as Error).message); }
  }
  /** Writes the worker's measurements of a training run to the log, one stage per line. */
  private logTraining(stats: TrainingStats) {
    const { preparation: p, training: t, validation: v } = stats, c = v.confusion;
    const percent = (part: number, whole: number) => whole ? `${(part / whole * 100).toFixed(1)}%` : '—';
    this.log(`Benchmark · preparation: ${p.images} images in ${seconds(p.wall)} = ${(p.images / (p.wall / 1000)).toFixed(1)} images/s · per image: ${p.load ? `load and resize ${ms(p.load)} (${p.parallelLoads} at a time), ` : ''}reference and difference ${ms(p.difference)}.`, 'benchmark');
    this.log(`Benchmark · features and scaling: ${ms(stats.features)} for ${p.images} images · ${t.inputs} network inputs.`, 'benchmark');
    this.log(`Benchmark · training on ${stats.mode}: ${t.epochs} epochs over ${t.images} images in ${seconds(t.time)} = ${ms(t.time / t.epochs)} per epoch.`, 'benchmark');
    this.log(`Benchmark · validation of ${c.tp + c.tn + c.fp + c.fn} held-out images in ${ms(v.time)}: TP ${c.tp}, TN ${c.tn}, FP ${c.fp}, FN ${c.fn} · precision ${percent(c.tp, c.tp + c.fp)}, recall ${percent(c.tp, c.tp + c.fn)}, accuracy ${percent(c.tp + c.tn, c.tp + c.tn + c.fp + c.fn)}.`, 'benchmark');
    const parts = (group: Record<string, { accuracy: number; count: number }>) => Object.entries(group).map(([name, { accuracy, count }]) => `${name} ${(accuracy * 100).toFixed(1)}% (${count})`).join(', ');
    this.log(`Benchmark · validation accuracy by group: ${parts(v.byGroup)} · by shape: ${parts(v.byShape)}.`, 'benchmark');
  }
  /** Saves the whole operation log as a text file, e.g. to take benchmark numbers from it. */
  saveLog() {
    const text = this.logs.map(line => `${line.time}\t${line.kind || 'info'}\t${line.text}`).join('\n');
    download(new Blob([text + '\n'], { type: 'text/plain' }), `operation-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`);
  }
  navigate(delta: number) { if (!this.result?.defects.length) return; this.selectDefect((this.defectIndex + delta + this.result.defects.length) % this.result.defects.length); }
  selectDefect(index: number) { this.defectIndex = index; this.log(`Defect ${index + 1} of ${this.result!.defects.length} selected.`); }
  selectCell(cell: number) { const index = this.result?.defects.findIndex(region => region.cells.includes(cell)) ?? -1; if (index >= 0) this.selectDefect(index); }
  isSuspicious(cell: number) { return this.result?.defects.some(region => region.cells.includes(cell)) ?? false; }
  location(axis: 'x' | 'y') { return this.defect ? this.defect[axis] : '—'; }
  cellColor(value: number, index: number) { return this.defect?.cells.includes(index) ? '#f14d73' : `rgb(${tone(value, 4).join(', ')})`; }
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
  saveResult() {
    if (!this.result) return;
    const { referenceUrl, differenceUrl, ...result } = this.result;
    download(new Blob([JSON.stringify({ ...result, gridSize: this.gridSize, processingSize: 200, features: 'Cell means of input − reference (grayscale, soft threshold 0.1)', coordinateSystem: 'Original image pixels; grid rows and columns are 1-based', inputImage: this.inputImage?.name, originalWidth: this.inputImage?.width, originalHeight: this.inputImage?.height, validationAccuracy: this.accuracy }, null, 2)], { type: 'application/json' }), 'defect-result.json');
    this.log('Saved input image recognition result (JSON).');
  }
}
