# Shape Defect Recognition

Single-page Angular application using Brain.js in a Web Worker. No backend is needed.

## Run and check

- `npm start` starts the local application.
- `npm run build` creates `dist/defects/browser`.
- `npm test -- --watch=false` runs component tests.
- `node --test tests/processing.test.cjs` checks preprocessing, localization and real Brain.js CPU training/inference.

## Workflow

Select Assets, a shape, or a quality group and train. The initial dataset contains 250 generated individual images. Each shape and quality group contains Clean and Defective classes. Add Images imports any number of PNG, JPG or BMP files into the selected class; dimensions may vary. Training requires at least two images per class, reserving approximately 20% of each class (at least one) for validation. Selecting a class alone is supported for inspection and import; classification training requires a broader scope containing both classes.

Upload one input image or load a dataset image, then choose Recognize Defects. Dataset changes invalidate the existing model. Data and models are held in memory for the session.

## Processing

Both training and recognition resize an image to 200 × 200 pixels. Transparent areas are composited over white. The worker computes grayscale intensity as the mean of RGB divided by 255, then averages each 20 × 20 pixel cell into a 10 × 10 grid. All 100 averages feed the Brain.js sigmoid classifier in row-major order. Per-cell scaling is fitted exclusively to the training partition and reused unchanged for validation and recognition; the displayed grid always contains the original averages. GPU execution is attempted with CPU fallback. Preparation counts, completed epochs, loss, held-out accuracy, and execution times are measured.

For a Defective classification, localization compares the intensity grid with the nearest clean training pattern. Abnormal cells are checked by replacing their intensity with the learned clean value and measuring the reduction in the model's defective score. Adjacent suspicious cells are grouped into regions. The UI synchronizes the selected region's original-image bounding box, highlighted grid cells, coordinates, size, average intensity and anomaly score. The anomaly score measures departure from the clean pattern, not a calibrated probability. If no supporting region can be found, the UI explicitly reports localization failure. Clean results hide region-specific controls.

PNG/JPG/BMP exports contain the input image with detected-region annotations. JSON contains the classification, confidence, raw intensity grid, original-image coordinates and bounding boxes, occupied cells, original image dimensions and execution time. Clean classifications export without annotations.

## Modules

- `src/app/images.ts`: individual-image dataset, synthetic samples, decoding and normalization.
- `public/engine/processing.js`: shared intensity extraction, feature vector and localization.
- `public/engine/worker.js`: Brain.js training, validation and inference.
- `src/app/app.ts`: application state and interaction handling.
- `src/app/export.ts`: downloads and BMP encoding.
- `public/engine/brain.js`: local browser distribution from the installed Brain.js dependency.


