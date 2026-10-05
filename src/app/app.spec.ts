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
    app.select('Assets'); expect(app.scope.length).toBe(250);
    app.select('Circle'); expect(app.scope.length).toBe(125);
    app.select('Circle/HighQuality'); expect(app.scope.length).toBe(80);
    app.select('Circle/HighQuality/Clean'); expect(app.scope.length).toBe(40);
    expect(app.scope.every(image => image.imageClass === 'Clean')).toBe(true);
    app.select('Circle/HighQuality/Defective'); expect(app.scope.length).toBe(40);
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

  it('hides region controls for a clean result while keeping its grid and exports', () => {
    const fixture = TestBed.createComponent(App), app = fixture.componentInstance;
    app.result = { grid: Array(100).fill(.1), defects: [], score: .1, confidence: .9, classification: 'No defect detected', elapsed: 3 };
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.result-summary')?.textContent).toContain('No defect detected');
    expect(element.querySelector('.result-summary')?.textContent).toContain('90.0%');
    expect(element.querySelector('.defect-nav')).toBeNull();
    expect(element.querySelector('.defect-metrics')).toBeNull();
    expect(element.querySelector('.preview')).toBeNull();
    expect(element.querySelectorAll('.intensity-grid > div').length).toBe(100);
    expect((element.querySelector('.export-row button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('updates region coordinates, average intensity and highlighted cells when navigating', () => {
    const fixture = TestBed.createComponent(App), app = fixture.componentInstance;
    app.inputImage = { name: 'shape.png', width: 400, height: 200, size: 100, url: '' };
    app.drawPreview = async () => {};
    app.result = { grid: Array(100).fill(.1), defects: [
      {x:40,y:60,cell:32,cells:[32,33],row:4,col:3,intensity:.25,area:20},
      {x:100,y:120,cell:65,cells:[65],row:7,col:6,intensity:.5,area:10},
    ], score:.95, confidence:.95, classification:'Defect detected', elapsed:3 };
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.highlighted').length).toBe(2);
    app.navigate(1); fixture.debugElement.injector.get(ChangeDetectorRef).markForCheck(); fixture.detectChanges();
    expect(app.location('x')).toBe(200); expect(app.location('y')).toBe(120);
    expect(fixture.nativeElement.querySelector('.defect-metrics').textContent).toContain('0.500');
    expect(fixture.nativeElement.querySelector('.defect-nav').textContent).toContain('Defect 2 of 2');
    expect(fixture.nativeElement.querySelectorAll('.highlighted').length).toBe(1);
  });

  it('rejects a single-class training scope without changing the dataset selection', async () => {
    const app = TestBed.createComponent(App).componentInstance;
    app.select('Circle/HighQuality/Clean'); await app.train();
    expect(app.error).toContain('two Clean and two Defective');
    expect(app.training).toBe(false); expect(app.scope.length).toBe(40);
  });

  it('clearing the dataset invalidates the model and previous results', () => {
    const app = TestBed.createComponent(App).componentInstance;
    app.trained = true; app.result = {grid:[],defects:[],score:.1,confidence:.9,classification:'No defect detected',elapsed:3};
    app.clearDataset();
    expect(app.images.length).toBe(0); expect(app.trained).toBe(false); expect(app.result).toBeUndefined(); expect(app.progress).toBe(0);
  });
});


