import { TestBed } from '@angular/core/testing';
import { ChangeDetectorRef } from '@angular/core';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    })
      .compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render title', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Shape Defect Recognition');
  });

  it('selects image counts at every dataset level', () => {
    const app = TestBed.createComponent(App).componentInstance;
    app.select('Assets'); expect(app.scope.length).toBe(5000);
    app.select('Circle'); expect(app.scope.length).toBe(1000);
    app.select('Circle/HighQuality'); expect(app.scope.length).toBe(600);
    app.select('Circle/HighQuality/Clean'); expect(app.scope.length).toBe(300);
    expect(app.scope.every(image => image.imageClass === 'Clean')).toBe(true);
    app.select('Circle/HighQuality/Defective'); expect(app.scope.length).toBe(300);
    expect(app.scope.every(image => image.imageClass === 'Defective')).toBe(true);
  });

  it('requires both an input image and trained model to enable recognition', () => {
    const fixture = TestBed.createComponent(App), app = fixture.componentInstance;
    fixture.detectChanges();
    const button = () => fixture.nativeElement.querySelector('.recognize-button') as HTMLButtonElement;
    expect(button().disabled).toBe(true);
    app.inputImage = { name: 'shape.png', width: 320, height: 180, size: 100, url: 'data:image/png;base64,' };
    fixture.debugElement.injector.get(ChangeDetectorRef).markForCheck(); fixture.detectChanges();
    expect(button().disabled).toBe(true);
    app.trained = true; fixture.debugElement.injector.get(ChangeDetectorRef).markForCheck(); fixture.detectChanges();
    expect(button().disabled).toBe(false);
    expect(fixture.nativeElement.querySelectorAll('.input-card').length).toBe(1);
    app.recognizing = true; fixture.debugElement.injector.get(ChangeDetectorRef).markForCheck(); fixture.detectChanges();
    expect(button().disabled).toBe(true);
  });

  const result = (extra = {}) => ({ grid: Array(400).fill(0), defects: [], score: .1, confidence: .9, classification: 'Clean', localizationStatus: 'not-needed' as const, elapsed: 3, referenceMethod: 'Opening and closing by reconstruction', referenceUrl: 'data:reference', differenceUrl: 'data:difference', ...extra });
  const region = (index: number, cells: number[], x: number, y: number, intensity: number) => ({ index, x, y, cell: cells[0], cells, row: Math.floor(cells[0] / 20) + 1, col: cells[0] % 20 + 1, intensity, area: 20, anomalyScore: .8, contribution: .1, bounds: { x: x - 10, y: y - 10, width: 20, height: 20 }, gridBounds: { rowStart: 1, rowEnd: 1, colStart: 1, colEnd: 1 } });

  it('shows a clean result without region controls while keeping its grid, reference and exports', () => {
    const fixture = TestBed.createComponent(App), app = fixture.componentInstance;
    app.inputImage = { name: 'shape.png', width: 400, height: 200, size: 100, url: 'data:input' };
    app.result = result();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.result-summary')?.textContent).toContain('Clean');
    expect(element.querySelector('.result-summary')?.textContent).toContain('90.0%');
    expect(element.querySelector('.defect-nav')).toBeNull();
    expect(element.querySelector('.defect-metrics')).toBeNull();
    expect(element.querySelectorAll('.region-outline').length).toBe(0);
    expect(element.querySelectorAll('.intensity-cell').length).toBe(400);
    expect((element.querySelector('.export-row button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('switches the preview between input, reference and difference layers', () => {
    const fixture = TestBed.createComponent(App), app = fixture.componentInstance;
    app.inputImage = { name: 'shape.png', width: 400, height: 200, size: 100, url: 'data:input' };
    app.result = result();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement, layer = () => element.querySelector('.region-preview image')?.getAttribute('href');
    expect(layer()).toBe('data:input');
    for (const [name, url] of [['Reference', 'data:reference'], ['Difference', 'data:difference']]) {
      (Array.from(element.querySelectorAll('.view-switch button')).find(button => button.textContent === name) as HTMLButtonElement).click();
      fixture.debugElement.injector.get(ChangeDetectorRef).markForCheck(); fixture.detectChanges();
      expect(layer()).toBe(url);
    }
    expect(element.querySelector('.view-switch + .image-caption')?.getAttribute('title')).toBe('Input − reference · amber brighter, cyan darker');
  });

  it('updates region coordinates, average intensity and highlighted cells when navigating', () => {
    const fixture = TestBed.createComponent(App), app = fixture.componentInstance;
    app.inputImage = { name: 'shape.png', width: 400, height: 200, size: 100, url: '' };
    app.result = result({ defects: [region(1, [62, 63], 40, 60, .25), region(2, [125], 200, 120, .5)], score: .95, confidence: .95, classification: 'Defective', localizationStatus: 'localized' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.highlighted').length).toBe(2);
    app.navigate(1); fixture.debugElement.injector.get(ChangeDetectorRef).markForCheck(); fixture.detectChanges();
    expect(app.location('x')).toBe(200); expect(app.location('y')).toBe(120);
    expect(fixture.nativeElement.querySelector('.defect-metrics').textContent).toContain('0.500');
    expect(fixture.nativeElement.querySelector('.defect-nav').textContent).toContain('Defect 2 of 2');
    expect(fixture.nativeElement.querySelectorAll('.highlighted').length).toBe(1);
  });

  it('combines several folders with Ctrl/⌘+click and counts overlaps once', () => {
    const app = TestBed.createComponent(App).componentInstance, ctrl = new MouseEvent('click', { ctrlKey: true });
    app.select('Square'); app.select('Triangle/Icons', ctrl); expect(app.scope.length).toBe(1400);
    // A parent absorbs its selected subfolders; they show as included rather than listed twice.
    app.select('Triangle', ctrl); expect(app.scope.length).toBe(2000); expect(app.scopeName).toBe('Square, Triangle');
    expect(app.included('Triangle/Icons')).toBe(true); expect(app.included('Triangle/Icons/Clean')).toBe(true); expect(app.included('Circle')).toBe(false);
    app.select('Triangle/HighQuality', ctrl); expect(app.scopeName).toBe('Square, Triangle');
    app.select('Square', ctrl); expect([...app.selected]).toEqual(['Triangle']);
    app.select('Triangle', ctrl); expect([...app.selected]).toEqual(['Triangle']);
    app.select('Assets', ctrl); expect([...app.selected]).toEqual(['Assets']); expect(app.included('Star/Icons')).toBe(true);
    app.select('Circle'); expect(app.scope.length).toBe(1000); expect(app.included('Circle')).toBe(false);
  });

  it('rejects a single-class training scope without changing the dataset selection', async () => {
    const app = TestBed.createComponent(App).componentInstance;
    app.select('Circle/HighQuality/Clean'); await app.train();
    expect(app.error).toContain('two Clean and two Defective');
    expect(app.training).toBe(false); expect(app.scope.length).toBe(300);
  });

  it('clearing removes only the selected folders and invalidates the model and previous results', () => {
    const app = TestBed.createComponent(App).componentInstance;
    app.trained = true; app.result = result();
    app.select('Square'); app.select('Star/HighQuality/Clean', new MouseEvent('click', { ctrlKey: true })); app.clearDataset();
    expect(app.images.length).toBe(3700); expect(app.images.some(image => image.shape === 'Square')).toBe(false);
    expect(app.trained).toBe(false); expect(app.result).toBeUndefined(); expect(app.progress).toBe(0);
    app.select('Assets'); app.clearDataset(); expect(app.images.length).toBe(0);
  });

  it('rejects shape names that collide with the tree root or an existing shape', () => {
    const app = TestBed.createComponent(App).componentInstance;
    for (const name of ['Assets', ' assets ', 'circle', 'a/b', '  ']) expect(app.validShape(name)).toBe(false);
    expect(app.validShape('Ellipse')).toBe(true);
  });
});


