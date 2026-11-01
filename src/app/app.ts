import { ChangeDetectorRef, Component, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import {
  ImageAsset,
  DatasetImage,
  ImageClass,
  SHAPES,
  GROUPS,
  SAMPLE_VERSION,
  sampleDataset,
  imageName,
  generateImage,
  renderImage,
  release,
  loadImage,
  urlAsset,
  normalize,
  decode,
  fieldImage,
} from './images';
import {
  Listing,
  FolderImage,
  FolderMeta,
  fileUrl,
  listDataset,
  readMeta,
  writeMeta,
  writeImage,
  makeFolder,
  removeImages,
  watchDataset,
  openFolder as showFolder,
} from './dataset';
import { bitmap, download } from './export';

interface Defect {
  index: number;
  x: number;
  y: number;
  cell: number;
  cells: number[];
  row: number;
  col: number;
  intensity: number;
  area: number;
  anomalyScore: number;
  contribution: number;
  bounds: { x: number; y: number; width: number; height: number };
  gridBounds: { rowStart: number; rowEnd: number; colStart: number; colEnd: number };
}

interface Result {
  grid: number[];
  defects: Defect[];
  score: number;
  confidence: number;
  classification: string;
  localizationStatus: 'localized' | 'failed' | 'not-needed';
  elapsed: number;
  referenceMethod: string;
  referenceUrl: string;
  differenceUrl: string;
}

type View = 'Input' | 'Reference' | 'Difference';
type Accuracy = Record<string, { accuracy: number; count: number }>;

interface TrainingStats {
  mode: string;
  features: number;
  preparation: {
    images: number;
    wall: number;
    load: number;
    difference: number;
    parallelLoads: number;
  };
  training: { time: number; epochs: number; images: number; inputs: number };
  validation: {
    time: number;
    confusion: { tp: number; tn: number; fp: number; fn: number };
    byGroup: Accuracy;
    byShape: Accuracy;
  };
}

interface WrittenSample {
  render: number;
  write: number;
  size: number;
}

const ms = (value: number) => `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ms`;
const seconds = (value: number) => `${(value / 1000).toFixed(1)} s`;
const percent = (part: number, whole: number) =>
  whole ? `${((part / whole) * 100).toFixed(1)}%` : '—';
const errorText = (e: unknown) => (e as Error).message;

// Amber = brighter than reference, cyan = darker.
const BASE = [8, 14, 29];
const BRIGHTER = [255, 196, 61];
const DARKER = [74, 195, 255];

function tone(value: number, gain: number) {
  const a = Math.min(1, Math.abs(value) * gain);
  const to = value >= 0 ? BRIGHTER : DARKER;
  return BASE.map((base, i) => Math.round(base + (to[i] - base) * a)) as [number, number, number];
}

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnDestroy {
  // Dataset tree
  images: DatasetImage[] = sampleDataset();
  shapes = [...SHAPES];
  groups = [...GROUPS];
  classes: ImageClass[] = ['Clean', 'Defective'];
  selected = new Set(['Circle/HighQuality']);
  expanded = new Set(['Assets', 'Circle', 'Circle/HighQuality']);

  // Dataset folder; empty when the dataset server isn't running.
  folder = '';
  generating = false;
  written = 0;
  missingSamples = 0;

  // Training
  epochs = 100;
  learningRate = 0.05;
  epoch = 0;
  prepared = 0;
  totalImages = 0;
  loss: number | null = null;
  accuracy: number | null = null;
  validationCount = 0;
  elapsed = 0;
  training = false;
  trained = false;
  status = 'Not trained';

  // Recognition
  recognizing = false;
  progress = 0;
  inputImage?: ImageAsset;
  result?: Result;
  defectIndex = 0;
  gridSize = 20;
  views: View[] = ['Input', 'Reference', 'Difference'];
  view: View = 'Input';
  format = 'PNG';

  // Dialogs and log
  loading = false;
  modal = '';
  shapeName = '';
  uploadShape = 'Circle';
  uploadGroup = 'HighQuality';
  imageClass: ImageClass = 'Defective';
  info?: ImageAsset;
  error = '';
  logs: { time: string; text: string; kind: string }[] = [];
  autoScroll = true;

  private folders: Record<string, string[]> = {};
  private inputPath?: string;
  private stopWatching?: () => void;
  private syncing = false;
  private chain = Promise.resolve();
  private queued?: Promise<void>;
  private worker?: Worker;
  private trainingStarted = 0;
  private recognitionStarted = 0;

  constructor(private cdr: ChangeDetectorRef) {
    this.connect();
  }

  ngOnDestroy() {
    this.worker?.terminate();
    this.stopWatching?.();
  }

  // ---- Dataset folder ----

  async connect() {
    try {
      const start = performance.now();
      const listing = await listDataset();
      this.folder = listing.root;
      this.apply(listing);
      this.stopWatching = watchDataset(() => {
        if (!this.syncing) this.sync();
      });

      const ignored = listing.ignored
        ? `, ${listing.ignored} entries outside Shape/Group/Clean|Defective ignored`
        : '';
      this.log(
        `Dataset folder ${listing.root}: ${listing.images.length} images${ignored}, ` +
          `listed in ${ms(performance.now() - start)}. Watching for changes.`,
      );

      // Generate only into a new folder, after an interrupted run or a generator update.
      const meta = await readMeta();
      const samples = new Set(sampleDataset().map((item) => this.samplePath(item)));
      const hasSamples = listing.images.some((image) => samples.has(image.path));
      const outdated = (meta.sampleVersion ?? 1) < SAMPLE_VERSION && hasSamples;
      if (!listing.shapes.length || meta.samples === 'writing' || outdated) {
        this.generateSamples(meta);
      }
    } catch {
      this.log(
        `Dataset folder unavailable (start with npm start); ` +
          `using ${this.images.length} generated images in memory.`,
      );
    }

    this.log('Select a training scope, then start training.');
    this.cdr.markForCheck();
  }

  // Apply listings in order so an old one never overwrites a newer one.
  sync(quiet = false): Promise<void> {
    if (this.queued && !quiet) return this.queued;

    this.chain = this.chain.then(() => {
      this.queued = undefined;
      return this.load(quiet);
    });
    this.queued = this.chain;
    return this.chain;
  }

  private async load(quiet: boolean) {
    try {
      const [added, removed] = this.apply(await listDataset());
      if (!quiet && !this.syncing && (added || removed)) {
        const hint = this.trained ? ' Retrain to include the changes.' : '';
        this.log(`Dataset folder changed: ${added} added, ${removed} removed.${hint}`);
      }
    } catch (e) {
      this.fail(`Dataset folder unavailable: ${errorText(e)}`);
    }
    this.cdr.markForCheck();
  }

  private apply(listing: Listing) {
    const counts = this.applyImages(listing.images);

    this.shapes = [
      ...SHAPES.filter((shape) => listing.shapes.includes(shape)),
      ...listing.shapes.filter((shape) => !SHAPES.includes(shape)).sort(),
    ];
    this.groups = [...GROUPS, ...listing.groups.filter((group) => !GROUPS.includes(group)).sort()];
    this.folders = listing.folders || {};
    this.dropRemovedFolders();

    const paths = new Set(listing.images.map((image) => image.path));
    this.missingSamples = sampleDataset().filter(
      (item) => !paths.has(this.samplePath(item)),
    ).length;

    if (this.inputPath && !paths.has(this.inputPath)) {
      this.log(
        `Input image ${this.inputImage?.name} was removed from the dataset folder; ` +
          `it stays loaded for recognition.`,
      );
      this.inputPath = undefined;
    }
    return counts;
  }

  // Keeps ids of files that didn't change. Returns [added, removed].
  private applyImages(files: FolderImage[]): [number, number] {
    const known = new Map(
      this.images.filter((image) => image.path).map((image) => [image.path!, image]),
    );
    let lastId = this.images.reduce((max, image) => Math.max(max, image.id), 0);
    let added = 0;

    this.images = files.map((file) => {
      const previous = known.get(file.path);
      if (!previous) added++;
      known.delete(file.path);

      if (previous && previous.modified === file.modified && previous.size === file.size) {
        return previous;
      }
      return {
        id: previous?.id ?? ++lastId,
        shape: file.shape,
        group: file.group,
        imageClass: file.imageClass,
        path: file.path,
        size: file.size,
        modified: file.modified,
      };
    });

    return [added, known.size];
  }

  private dropRemovedFolders() {
    const exists = (key: string) => {
      const [shape, group] = key.split('/');
      if (key === 'Assets') return true;
      return this.shapes.includes(shape) && (!group || this.groupsOf(shape).includes(group));
    };

    const kept = [...this.selected].filter(exists);
    if (kept.length === this.selected.size) return;

    const gone = [...this.selected]
      .filter((key) => !exists(key))
      .map((key) => key.replaceAll('/', ' / '));
    this.selected = new Set(kept.length ? kept : ['Assets']);
    this.log(
      `${gone.join(', ')} no longer in the dataset folder; training selection is now ${this.scopeName}.`,
    );
  }

  get trash() {
    const separator = this.folder.includes('\\') ? '\\' : '/';
    return `${this.folder}${separator}.removed`;
  }

  samplePath(item: DatasetImage) {
    return `${item.shape}/${item.group}/${item.imageClass}/${imageName(item)}`;
  }

  async openFolder() {
    const [key] = this.selected;
    const target = this.selected.size === 1 && key !== 'Assets' ? key : '';
    try {
      await showFolder(target);
      const name = target ? target.replaceAll('/', ' / ') : 'the dataset folder';
      this.log(`Opened ${name} in the file manager.`);
    } catch (e) {
      this.fail(errorText(e));
    }
  }

  // ---- Sample generation ----

  // Writes missing samples; after a generator update also rewrites the old ones.
  async generateSamples(meta: FolderMeta = {}) {
    if (this.busy || !this.folder) return;

    const all = sampleDataset();
    const plan = this.planSamples(all, meta);
    if (!plan.items.length) {
      await this.saveMeta({ sampleVersion: SAMPLE_VERSION, samples: 'complete' });
      return;
    }

    if (plan.rewriting) {
      this.log(
        `Sample generator updated to version ${SAMPLE_VERSION}: rewriting ${plan.rewriting} ` +
          `generated images; images you added are kept.`,
      );
    }

    this.generating = this.syncing = true;
    this.written = all.length - plan.items.length;
    this.invalidateModel();
    await this.saveMeta({
      sampleVersion: SAMPLE_VERSION,
      samples: 'writing',
      started: plan.started,
      rewrite: plan.rewrite,
    });

    let message = `Restoring ${plan.items.length} missing generated images in ${this.folder}…`;
    if (plan.items.length === all.length) {
      message = `Writing ${all.length} generated PNG images to ${this.folder}…`;
    } else if (plan.resuming) {
      message = `Continuing the sample dataset: ${plan.items.length} of ${all.length} PNG images still to write in ${this.folder}…`;
    }
    this.log(message);

    const pool = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    const progress = this.sampleProgress(all, plan.items);
    const failure = await this.runGenerators(plan.items, pool, progress.record);
    const time = performance.now() - progress.started;

    if (failure) {
      this.fail(
        `Writing the sample dataset stopped at ${this.written} / ${all.length}: ${failure.message} ` +
          `Reload the page or use Restore below the tree to continue.`,
      );
    } else {
      await this.saveMeta({ sampleVersion: SAMPLE_VERSION, samples: 'complete' });
      this.log(
        `Sample dataset written: ${all.length} images (${plan.items.length} generated in ${seconds(time)}).`,
        'success',
      );
    }

    const cost = progress.cost;
    if (cost.count) {
      const rate = cost.count / (time / 1000);
      this.log(
        `Benchmark · generation: ${cost.count} images in ${seconds(time)} with ${pool} web workers = ` +
          `${rate.toFixed(1)} images/s · per image in a worker: render and PNG encoding ` +
          `${ms(cost.render / cost.count)}, writing ${ms(cost.write / cost.count)} · ` +
          `average PNG ${(cost.bytes / cost.count / 1024).toFixed(0)} KB.`,
        'benchmark',
      );
    }

    this.generating = this.syncing = false;
    await this.sync(true);
  }

  private saveMeta(meta: FolderMeta) {
    return writeMeta(meta).catch(() => {});
  }

  // Which samples to write. A rewrite skips files this run already wrote (newer than `started`).
  private planSamples(all: DatasetImage[], meta: FolderMeta) {
    const saved = new Map(this.images.map((image) => [image.path, image]));
    const resuming = meta.samples === 'writing' && meta.sampleVersion === SAMPLE_VERSION;
    const rewrite = resuming ? !!meta.rewrite : (meta.sampleVersion ?? 1) < SAMPLE_VERSION;
    const started = (resuming && meta.started) || Date.now();

    const items = all.filter((item) => {
      const file = saved.get(this.samplePath(item));
      return !file || (rewrite && (file.modified ?? 0) < started);
    });
    const rewriting = items.filter((item) => saved.has(this.samplePath(item))).length;

    return { items, resuming, rewrite, started, rewriting };
  }

  private sampleProgress(all: DatasetImage[], items: DatasetImage[]) {
    const folderOf = (item: DatasetImage) => `${item.shape} / ${item.group} / ${item.imageClass}`;
    const left = new Map<string, number>();
    for (const item of items) left.set(folderOf(item), (left.get(folderOf(item)) || 0) + 1);

    const started = performance.now();
    const writtenBefore = this.written;
    const cost = { render: 0, write: 0, bytes: 0, count: 0 };

    const record = (item: DatasetImage, data: WrittenSample) => {
      this.written++;
      cost.render += data.render;
      cost.write += data.write;
      cost.bytes += data.size;
      cost.count++;

      const folder = folderOf(item);
      const remaining = left.get(folder)! - 1;
      left.set(folder, remaining);
      if (remaining === 0) {
        const total = all.filter((other) => folderOf(other) === folder).length;
        this.log(`Generated ${folder}: ${total} images.`);
      }

      if (this.written % 500 === 0) {
        const rate = (this.written - writtenBefore) / ((performance.now() - started) / 1000);
        const secondsLeft = Math.ceil((all.length - this.written) / rate);
        this.log(
          `Generating images: ${this.written} / ${all.length} · ${rate.toFixed(0)} images/s · about ${secondsLeft} s left.`,
        );
      }
      if (this.written % 250 === 0) this.sync(true);
      this.cdr.markForCheck();
    };

    return { record, cost, started };
  }

  // Pool of workers, each one takes the next image when it's done. Resolves to the first error, if any.
  private runGenerators(
    items: DatasetImage[],
    pool: number,
    onWritten: (item: DatasetImage, data: WrittenSample) => void,
  ) {
    let next = 0;
    let failure: Error | undefined;

    return new Promise<Error | undefined>((done) => {
      let active = pool;
      const finish = (worker: Worker) => {
        worker.terminate();
        if (--active === 0) done(failure);
      };

      const feed = (worker: Worker) => {
        if (failure || next >= items.length) return finish(worker);

        const item = items[next++];
        worker.onmessage = ({ data }) => {
          if (data.error) failure ||= Error(data.error);
          else onWritten(item, data);
          feed(worker);
        };
        worker.postMessage({
          item: { id: item.id, shape: item.shape, group: item.group, imageClass: item.imageClass },
          path: this.samplePath(item),
        });
      };

      for (let i = 0; i < pool; i++) {
        const worker = new Worker(new URL('./generator.worker', import.meta.url), {
          type: 'module',
        });
        worker.onerror = (event) => {
          failure ||= Error(event.message || 'Image generator worker failed to load.');
          finish(worker);
        };
        feed(worker);
      }
    });
  }

  // ---- Tree ----

  get scope(): DatasetImage[] {
    const keys = [...this.selected];
    const inFolder = (image: DatasetImage, key: string) =>
      key === 'Assets' ||
      key === image.shape ||
      key === `${image.shape}/${image.group}` ||
      key === `${image.shape}/${image.group}/${image.imageClass}`;

    return this.images.filter((image) => keys.some((key) => inFolder(image, key)));
  }

  get scopeName() {
    return [...this.selected].map((key) => key.replaceAll('/', ' / ')).join(', ');
  }

  // A folder inside another selected folder.
  included(key: string) {
    return [...this.selected].some(
      (other) => other !== key && (other === 'Assets' || key.startsWith(other + '/')),
    );
  }

  count(shape: string, group?: string, imageClass?: ImageClass) {
    return this.images.filter(
      (image) =>
        image.shape === shape &&
        (!group || image.group === group) &&
        (!imageClass || image.imageClass === imageClass),
    ).length;
  }

  children(shape: string, group: string, imageClass: ImageClass) {
    return this.images.filter(
      (image) => image.shape === shape && image.group === group && image.imageClass === imageClass,
    );
  }

  name(image: DatasetImage) {
    return imageName(image);
  }

  groupsOf(shape: string) {
    const extra = (this.folders[shape] || []).filter((group) => !GROUPS.includes(group)).sort();
    return [...GROUPS, ...extra];
  }

  toggle(key: string) {
    if (this.expanded.has(key)) this.expanded.delete(key);
    else this.expanded.add(key);
  }

  // Ctrl/Cmd+click toggles a folder.
  select(key: string, event?: MouseEvent) {
    if (this.training) return;

    if (!event?.ctrlKey && !event?.metaKey) {
      this.selected = new Set([key]);
      return;
    }
    if (this.included(key)) return;

    if (this.selected.has(key)) {
      if (this.selected.size > 1) this.selected.delete(key);
      return;
    }

    // A folder replaces its selected subfolders.
    for (const other of this.selected) {
      if (key === 'Assets' || other.startsWith(key + '/')) this.selected.delete(other);
    }
    this.selected.add(key);
  }

  // 'Assets' is the tree root key.
  validShape(name: string) {
    const n = name.trim().toLowerCase();
    const taken = this.shapes.some((shape) => shape.toLowerCase() === n);
    return !!n && !n.includes('/') && n !== 'assets' && !taken;
  }

  addShape() {
    const name = this.shapeName.trim();
    if (!this.validShape(name)) return;

    if (this.folder) {
      makeFolder(name).then(
        () => this.sync(true),
        (e) => this.fail(errorText(e)),
      );
    }

    this.shapes.push(name);
    this.selected = new Set([name]);
    this.expanded.add(name);
    this.shapeName = '';
    this.modal = '';
    this.log(`Shape added: ${name}.`);
  }

  // ---- Dataset changes ----

  async clearDataset() {
    const removed = this.scope;
    const name = this.scopeName;
    this.modal = '';

    if (this.folder) await this.moveToTrash(removed, name);
    else this.removeFromMemory(removed, name);
  }

  private async moveToTrash(images: DatasetImage[], name: string) {
    this.syncing = true;
    try {
      const paths = images.filter((image) => image.path).map((image) => image.path!);
      const moved = await removeImages(paths);
      this.invalidateModel();
      this.log(`Moved ${moved} images from ${name} to ${this.trash}.`);
    } catch (e) {
      this.fail(errorText(e));
    }
    this.syncing = false;

    this.selected = new Set(['Assets']);
    await this.sync(true);
  }

  private removeFromMemory(images: DatasetImage[], name: string) {
    const removed = new Set(images);
    for (const image of removed) {
      if (image.asset?.url.startsWith('blob:') && image.asset !== this.inputImage) {
        URL.revokeObjectURL(image.asset.url);
      }
    }

    this.images = this.images.filter((image) => !removed.has(image));
    this.selected = new Set(['Assets']);
    this.invalidateModel();
    this.log(`Removed ${removed.size} images from ${name}.`);
  }

  restoreSamples() {
    if (this.folder) {
      readMeta().then(
        (meta) => this.generateSamples(meta),
        (e) => this.fail(errorText(e)),
      );
      return;
    }

    this.images = sampleDataset();
    this.shapes = [...SHAPES];
    this.selected = new Set(['Circle/HighQuality']);
    this.invalidateModel();
    this.log(`Sample dataset restored: ${this.images.length} images.`);
  }

  openImport() {
    const [shape, group, imageClass] = [...this.selected][0].split('/');
    this.uploadShape = this.shapes.includes(shape) ? shape : this.shapes[0];
    this.uploadGroup = group || 'HighQuality';
    this.imageClass = imageClass === 'Clean' ? 'Clean' : 'Defective';
    this.modal = 'images';
  }

  async upload(event: Event, target: 'recognition' | 'dataset') {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length || this.busy) return;

    this.error = '';
    this.loading = true;
    try {
      if (target === 'recognition') await this.loadInput(files);
      else await this.addImages(files);
    } catch (e) {
      this.fail(errorText(e));
    }
    this.loading = false;
    this.cdr.markForCheck();
  }

  private async loadInput(files: File[]) {
    if (files.length !== 1) throw Error('Choose one PNG, JPG or BMP image.');

    this.inputImage = await loadImage(files[0]);
    this.inputPath = undefined;
    this.resetResult();
    this.log(`Input image loaded: ${this.inputImage.name}.`);
  }

  // One bad file doesn't stop the others.
  private async addImages(files: File[]) {
    const loaded = await Promise.allSettled(files.map(loadImage));
    const accepted = files.filter((_, i) => loaded[i].status === 'fulfilled');
    const rejected = files
      .filter((_, i) => loaded[i].status === 'rejected')
      .map((file) => file.name);
    const assets = loaded.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );

    if (assets.length) {
      if (this.folder) await this.copyToFolder(accepted, assets);
      else this.addToMemory(assets);

      this.invalidateModel();
      this.log(
        `Added ${assets.length} ${this.imageClass} images to ${this.uploadShape} / ${this.uploadGroup}.`,
      );
      this.modal = '';
    }

    if (rejected.length) {
      const files = rejected.length === 1 ? 'file' : 'files';
      this.fail(
        `Skipped ${rejected.length} unsupported or unreadable ${files} (PNG, JPG or BMP only): ` +
          `${rejected.join(', ')}.`,
      );
    }
  }

  private async copyToFolder(files: File[], assets: ImageAsset[]) {
    const folder = `${this.uploadShape}/${this.uploadGroup}/${this.imageClass}`;
    this.syncing = true;
    try {
      for (const file of files) await writeImage(`${folder}/${file.name}`, file);
    } finally {
      this.syncing = false;
      for (const asset of assets) URL.revokeObjectURL(asset.url);
    }
    await this.sync(true);
  }

  private addToMemory(assets: ImageAsset[]) {
    let lastId = this.images.reduce((max, image) => Math.max(max, image.id), 0);
    for (const asset of assets) {
      this.images.push({
        id: ++lastId,
        shape: this.uploadShape,
        group: this.uploadGroup,
        imageClass: this.imageClass,
        asset,
      });
    }
  }

  async useImage(image: DatasetImage) {
    if (this.busy) return;

    try {
      const previous = this.inputImage;
      if (image.asset) this.inputImage = image.asset;
      else if (image.path) this.inputImage = await urlAsset(fileUrl(image.path), imageName(image));
      else this.inputImage = await generateImage(image);

      this.inputPath = image.path;
      this.resetResult();
      this.log(`Input image loaded: ${this.inputImage.name}.`);

      const previousIsTemporary = !this.images.some((other) => other.asset === previous);
      if (previous?.url.startsWith('blob:') && previousIsTemporary) {
        URL.revokeObjectURL(previous.url);
      }
    } catch (e) {
      this.fail(errorText(e));
    }
    this.cdr.markForCheck();
  }

  // ---- Training and recognition ----

  get busy() {
    return this.training || this.recognizing || this.loading || this.generating;
  }

  resetResult() {
    this.result = undefined;
    this.progress = 0;
    this.defectIndex = 0;
  }

  invalidateModel() {
    this.worker?.terminate();
    this.worker = undefined;
    this.trained = false;
    this.status = 'Not trained';
    this.epoch = this.prepared = this.totalImages = this.elapsed = 0;
    this.loss = this.accuracy = null;
    this.validationCount = 0;
    this.resetResult();
  }

  createWorker() {
    this.worker?.terminate();
    this.worker = new Worker('engine/worker.js');

    this.worker.onerror = (e) => {
      this.training = this.recognizing = this.trained = false;
      this.status = 'Not trained';
      this.fail(e.message || 'Worker failed to load.');
    };
    this.worker.onmessage = ({ data }) => {
      this.onWorkerMessage(data);
      this.cdr.markForCheck();
    };
  }

  private onWorkerMessage(data: any) {
    switch (data.type) {
      case 'prepared':
        this.prepared = data.count;
        break;
      case 'mode':
        this.status = 'Training in progress';
        this.log(
          `Image preparation completed: ${this.prepared} / ${this.totalImages}. Training on ${data.mode}.`,
        );
        break;
      case 'epoch':
        this.onEpoch(data);
        break;
      case 'trained':
        this.onTrained(data);
        break;
      case 'recognitionProgress':
        this.progress = data.progress;
        break;
      case 'recognized':
        this.onRecognized(data);
        break;
      case 'error':
        this.training = this.recognizing = false;
        this.status = this.trained ? 'Training completed' : 'Training failed';
        this.fail(data.message);
        break;
    }
  }

  private onEpoch(data: any) {
    this.epoch = data.epoch;
    this.loss = data.loss;
    this.elapsed = performance.now() - this.trainingStarted;
    if (data.epoch === 1 || data.epoch % 10 === 0) {
      this.log(`Epoch ${data.epoch}/${this.epochs} · loss ${data.loss.toFixed(5)}.`);
    }
  }

  private onTrained(data: any) {
    this.training = false;
    this.trained = true;
    this.status = 'Training completed';
    this.epoch = data.epoch;
    this.loss = data.loss;
    this.accuracy = data.accuracy;
    this.validationCount = data.validationCount;
    this.elapsed = performance.now() - this.trainingStarted;

    const accuracy = (data.accuracy * 100).toFixed(1);
    this.log(
      `Training completed · validation accuracy ${accuracy}% (${data.validationCount} images).`,
      'success',
    );
    if (data.stats) this.logTraining(data.stats);
  }

  private onRecognized(data: any) {
    const { reference, difference, type, ...result } = data;
    this.result = {
      ...result,
      elapsed: performance.now() - this.recognitionStarted,
      referenceUrl: fieldImage(reference, (value) => [value * 255, value * 255, value * 255]),
      differenceUrl: fieldImage(difference, (value) => tone(value, 2.5)),
    };
    this.recognizing = false;
    this.progress = 100;
    this.defectIndex = 0;

    this.log(`Reference: ${data.referenceMethod}.`);
    if (data.timings) this.logRecognition(data.timings, this.result!.elapsed);

    if (data.localizationStatus === 'failed') {
      this.log('Defect detected, but localization failed.', 'error');
    } else {
      this.log(
        `Input image recognition completed in ${this.result!.elapsed.toFixed(1)} ms · ` +
          `${data.classification} · Detected regions: ${data.defects.length}.`,
        'success',
      );
    }
  }

  private trainingSettingsError() {
    const epochsOk = Number.isInteger(this.epochs) && this.epochs >= 1 && this.epochs <= 5000;
    const rateOk =
      Number.isFinite(this.learningRate) && this.learningRate > 0 && this.learningRate <= 1;
    if (!epochsOk || !rateOk) {
      return 'Use 1–5000 epochs and a learning rate greater than 0 and at most 1.';
    }

    const tooFew = this.classes.some(
      (imageClass) => this.scope.filter((image) => image.imageClass === imageClass).length < 2,
    );
    if (tooFew) {
      return 'Select at least two Clean and two Defective images for training and validation.';
    }

    return '';
  }

  async train() {
    if (this.busy) return;

    const problem = this.trainingSettingsError();
    if (problem) {
      this.fail(problem);
      return;
    }

    this.error = '';
    this.training = true;
    this.trained = false;
    this.result = undefined;
    this.epoch = 0;
    this.prepared = 0;
    this.loss = this.accuracy = null;
    this.elapsed = 0;
    this.resetResult();
    this.trainingStarted = performance.now();
    this.status = 'Preparing images';

    const scope = [...this.scope];
    this.totalImages = scope.length;
    this.createWorker();
    this.log(
      `Training started: ${this.scopeName} · ${scope.length} images · ` +
        `features: ${this.gridSize} × ${this.gridSize} grid of input − reference.`,
    );

    try {
      await this.sendSamples(scope);
      this.worker!.postMessage({
        type: 'train',
        epochs: this.epochs,
        learningRate: this.learningRate,
      });
    } catch (e) {
      this.training = false;
      this.status = 'Training failed';
      this.fail(errorText(e));
    }
  }

  // Files are sent by URL, the worker loads them itself. Generated images are rendered here.
  private async sendSamples(images: DatasetImage[]) {
    for (const [i, image] of images.entries()) {
      const labels = { imageClass: image.imageClass, shape: image.shape, group: image.group };
      const url = image.asset?.url || (image.path && fileUrl(image.path));
      if (url) {
        this.worker!.postMessage({ type: 'sample', url, ...labels });
        continue;
      }

      const rendered = renderImage(image);
      const pixels = normalize(rendered);
      release(rendered);
      this.worker!.postMessage({ type: 'sample', pixels, ...labels }, [pixels.buffer]);

      // Let the page breathe while rendering.
      if (i % 25 === 24) await new Promise((resolve) => setTimeout(resolve));
    }
  }

  async recognize() {
    if (!this.inputImage || !this.trained || this.busy) return;

    this.error = '';
    this.resetResult();
    this.recognizing = true;
    this.recognitionStarted = performance.now();
    this.progress = 25;
    this.cdr.markForCheck();

    try {
      const { url, width, height } = this.inputImage;
      this.worker!.postMessage({ type: 'recognize', url, width, height });
    } catch (e) {
      this.recognizing = false;
      this.fail(errorText(e));
    }
  }

  // ---- Log ----

  log(text: string, kind = '') {
    this.logs.push({ time: new Date().toLocaleTimeString('en-GB'), text, kind });
    if (this.logs.length > 2000) this.logs.shift();

    if (this.autoScroll) {
      setTimeout(() => {
        const lines = document.getElementById('log-lines');
        if (lines) lines.scrollTop = lines.scrollHeight;
      });
    }
  }

  fail(message: string) {
    this.error = message;
    this.log(message, 'error');
    this.cdr.markForCheck();
  }

  private logTraining(stats: TrainingStats) {
    const { preparation: p, training: t, validation: v } = stats;
    const c = v.confusion;
    const total = c.tp + c.tn + c.fp + c.fn;
    const loading = p.load ? `load and resize ${ms(p.load)} (${p.parallelLoads} at a time), ` : '';
    const rate = (p.images / (p.wall / 1000)).toFixed(1);
    const byName = (accuracy: Accuracy) =>
      Object.entries(accuracy)
        .map(([name, { accuracy, count }]) => `${name} ${(accuracy * 100).toFixed(1)}% (${count})`)
        .join(', ');

    const lines = [
      `preparation: ${p.images} images in ${seconds(p.wall)} = ${rate} images/s · per image: ` +
        `${loading}reference and difference ${ms(p.difference)}.`,
      `features and scaling: ${ms(stats.features)} for ${p.images} images · ${t.inputs} network inputs.`,
      `training on ${stats.mode}: ${t.epochs} epochs over ${t.images} images in ${seconds(t.time)} = ` +
        `${ms(t.time / t.epochs)} per epoch.`,
      `validation of ${total} held-out images in ${ms(v.time)}: TP ${c.tp}, TN ${c.tn}, FP ${c.fp}, ` +
        `FN ${c.fn} · precision ${percent(c.tp, c.tp + c.fp)}, recall ${percent(c.tp, c.tp + c.fn)}, ` +
        `accuracy ${percent(c.tp + c.tn, total)}.`,
      `validation accuracy by group: ${byName(v.byGroup)} · by shape: ${byName(v.byShape)}.`,
    ];
    for (const line of lines) this.log(`Benchmark · ${line}`, 'benchmark');
  }

  private logRecognition(t: Record<string, number>, roundTrip: number) {
    const image = this.inputImage;
    this.log(
      `Benchmark · recognition of ${image?.name} (${image?.width}×${image?.height}): ` +
        `load and resize ${ms(t['load'])}, reference and difference ${ms(t['difference'])}, ` +
        `network ${ms(t['network'])}, localization ${ms(t['localization'])} · ` +
        `${ms(t['total'])} in the worker, ${ms(roundTrip)} from the page (messaging included).`,
      'benchmark',
    );
  }

  saveLog() {
    const text = this.logs
      .map((line) => `${line.time}\t${line.kind || 'info'}\t${line.text}`)
      .join('\n');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    download(new Blob([text + '\n'], { type: 'text/plain' }), `operation-log-${stamp}.txt`);
  }

  // ---- Result view ----

  get defect() {
    return this.result?.defects[this.defectIndex];
  }

  get previewUrl() {
    if (this.view === 'Reference') return this.result!.referenceUrl;
    if (this.view === 'Difference') return this.result!.differenceUrl;
    return this.inputImage!.url;
  }

  get caption() {
    if (this.view === 'Reference') return 'Reference: defect-free estimate of the input';
    if (this.view === 'Difference') return 'Input − reference · amber brighter, cyan darker';

    const d = this.defect;
    if (!d) return 'No defect regions';
    const cells = d.cells.length === 1 ? 'cell' : 'cells';
    return `${d.cells.length} ${cells} selected · X ${d.bounds.x} / Y ${d.bounds.y}`;
  }

  navigate(delta: number) {
    const count = this.result?.defects.length;
    if (!count) return;
    this.selectDefect((this.defectIndex + delta + count) % count);
  }

  selectDefect(index: number) {
    this.defectIndex = index;
    this.log(`Defect ${index + 1} of ${this.result!.defects.length} selected.`);
  }

  selectCell(cell: number) {
    const index = this.result?.defects.findIndex((region) => region.cells.includes(cell)) ?? -1;
    if (index >= 0) this.selectDefect(index);
  }

  isSuspicious(cell: number) {
    return this.result?.defects.some((region) => region.cells.includes(cell)) ?? false;
  }

  location(axis: 'x' | 'y') {
    return this.defect ? this.defect[axis] : '—';
  }

  cellColor(value: number, index: number) {
    if (this.defect?.cells.includes(index)) return '#f14d73';
    return `rgb(${tone(value, 4).join(', ')})`;
  }

  // ---- Export ----

  async saveImage() {
    if (!this.result || !this.inputImage) return;

    const canvas = await this.annotatedImage(this.result.defects);
    const ext = this.format.toLowerCase();
    if (ext === 'bmp') {
      download(bitmap(canvas), 'defect-result.bmp');
    } else {
      const type = ext === 'jpg' ? 'image/jpeg' : 'image/png';
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.95));
      if (blob) download(blob, `defect-result.${ext}`);
    }
    this.log(`Saved annotated result image (${this.format}).`);
  }

  private async annotatedImage(defects: Defect[]) {
    const image = await decode(this.inputImage!.url);
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;

    const c = canvas.getContext('2d')!;
    c.fillStyle = '#fff';
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.drawImage(image, 0, 0);

    c.strokeStyle = '#f14d73';
    c.lineWidth = Math.max(2, image.width / 200);
    c.fillStyle = '#f14d7326';
    for (const { bounds } of defects) {
      c.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
      c.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
    }
    return canvas;
  }

  saveResult() {
    if (!this.result) return;

    const { referenceUrl, differenceUrl, ...result } = this.result;
    const report = {
      ...result,
      gridSize: this.gridSize,
      processingSize: 200,
      features: 'Cell means of input − reference (grayscale, soft threshold 0.1)',
      coordinateSystem: 'Original image pixels; grid rows and columns are 1-based',
      inputImage: this.inputImage?.name,
      originalWidth: this.inputImage?.width,
      originalHeight: this.inputImage?.height,
      validationAccuracy: this.accuracy,
    };
    const json = JSON.stringify(report, null, 2);
    download(new Blob([json], { type: 'application/json' }), 'defect-result.json');
    this.log('Saved input image recognition result (JSON).');
  }
}
