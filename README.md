# Shape Defect Recognition

Single-page Angular application using Brain.js in a Web Worker. No backend is needed.

## Run and check

- `npm start` starts the dataset folder server and the application; `ng serve` proxies `/api` to the server.
- `npm run build` creates `dist/defects/browser`.
- `npm test -- --watch=false` runs component tests.
- `node --test tests/processing.test.cjs` checks the reference, difference grid, localization and real Brain.js CPU training/inference.
- `node --test tests/dataset-server.test.mjs` checks the dataset folder server.

## Dataset folder

The dataset lives in `dataset/` (ignored by git; `DATASET_DIR` and `DATASET_PORT` override the folder and the port 4310). The layout is the labelling: `Shape/Group/Clean|Defective/image.png`, with PNG, JPG or BMP files. `server/dataset.mjs` lists, serves, writes and removes images and watches the folder, so files or folders added, changed or deleted by hand appear in the tree within a moment; a new shape or group folder becomes a new tree node. Files outside that layout are ignored and counted in the log.

On the first start, an empty folder is filled with the 5000 generated images as PNG (about 750 MB), rendered and written by web workers so a background tab does not slow them down. Later starts reuse the saved files as they are. `dataset/.meta.json` records the generator version and whether writing finished: an interrupted run continues with the images it has not written yet, and a newer generator rewrites the generated images once, leaving images you added untouched. When generated images are missing (deleted by hand or cleared), the tree offers Restore, which writes only the missing ones. Removed folders leave the training selection, and an input image taken from the folder stays loaded after its file is deleted. Open Folder shows the selected tree folder (or the dataset folder) in the system file manager. Add Images copies files into the folder, Add Shape creates a folder, and Clear moves the selected images into `dataset/.removed/<time>/`, from where they can be restored. Without the server (for example plain `ng serve`) the application keeps the generated dataset in memory as before.

## Workflow

Select Assets, a shape, or a quality group and train. The initial dataset contains 5000 generated individual images: five shapes (Circle, Square, Triangle, Hexagon, Star), each with 600 HighQuality and 400 Icons images split evenly into Clean and Defective classes.

Images are generated deterministically from their id, so an image renders the same for training, preview and export; with the dataset folder they are saved once as PNG (see Dataset folder). Each image varies in size, aspect ratio, shape position, scale, rotation and edge irregularity; background and shape colours (flat, linear or radial gradients); surface texture (hatching, speckles, smudges) and shadows. Shape lightness stays below 70% and apart from the background, so only defects are white. Defective images contain one to four inclusions: round spots, irregular blobs, scratches, thin cracks or tiny specks, about a quarter of them small. White holes go on darker shapes, dark inclusions on lighter ones, either on mid-tone shapes; every defect differs from the shape by at least 0.3 in grayscale, is large enough to survive the 200 × 200 resize and the blur, and keeps a gap from the outline (a defect reaching a background of its own tone would look like a notch in the outline). HighQuality images are 320–480 px and mostly sharp; Icons are 64–128 px, blurred and noisier. Images get film grain, and some of them also per-pixel noise. Ctrl/⌘+click adds or removes folders, so several folders can be trained together; an image in overlapping folders counts once. Clear removes the images of the selected folders. Add Images imports any number of PNG, JPG or BMP files into the selected class; dimensions may vary, and unreadable files are skipped and listed without discarding the valid ones. Training requires at least two images per class, reserving approximately 20% of each class (at least one) for validation. Selecting a class alone is supported for inspection and import; classification training requires a broader scope containing both classes.

Upload one input image or load a dataset image, then choose Recognize Defects. Dataset changes invalidate the existing model. Data and models are held in memory for the session.

## Processing

The classifier follows the second method of the ANN_defects article: the network reads mean values of grid cells laid over a difference image (test − reference). Recognition still takes one image; its reference is derived from the image itself.

1. The image is resized to 200 × 200 pixels, transparent areas are composited over white, and grayscale is the mean of RGB divided by 255.
2. The reference is a defect-free estimate: opening by reconstruction removes bright structures a 21 × 21 px square cannot fit into (holes, scratches, specks), and closing by reconstruction then removes such dark structures. Reconstruction restores the shape whole, sharp corners included, so only defects differ from it.
3. The difference is grayscale − reference, with a soft threshold of 0.1 that drops weak residuals (sensor noise, texture, anti-aliasing). Brighter defects are positive, darker ones negative.
4. The difference is averaged over a 20 × 20 grid of 10 × 10 px cells. The network (Brain.js, sigmoid, one hidden layer of 12 neurons) reads 403 inputs, scaled by one factor fitted on the training partition only: for each cell, how far its magnitude rises above the mean of its 8 neighbours (square-rooted, so a defect covering part of one cell stands well above the zero of a clean cell, and a dark defect weighs as much as a bright one), plus three grid-wide inputs: the total difference, the strongest cell and the number of non-zero cells.

Training hands images to a Web Worker, which loads files and uploads by URL itself (six at a time, unaffected by a background tab) and reduces each to its grid; recognition reads its image the same way. The worker shuffles and splits each class 80/20 into training and held-out validation, and attempts GPU execution with CPU fallback. Preparation counts, completed epochs, loss, held-out accuracy and execution times are measured.

For a Defective classification, cells whose mean difference reaches 0.008 are suspicious; 8-adjacent suspicious cells form one region. Regions are ranked by how much clearing them lowers the network's defective score, then by their total difference. The UI synchronizes the selected region's original-image bounding box, highlighted grid cells, coordinates, size, average difference and anomaly score (a measure of departure from the reference, not a calibrated probability). The Defect Preview switches between the input, the reference that was used and the difference image. If no supporting region can be found, the UI explicitly reports localization failure.

PNG/JPG/BMP exports contain the input image with detected-region annotations. JSON contains the classification, confidence, the 20 × 20 difference grid, the reference method, original-image coordinates and bounding boxes, occupied cells, original image dimensions and execution time. Clean classifications export without annotations.

## Modules

- `src/app/images.ts`: individual-image dataset, synthetic samples, decoding and normalization.
- `public/engine/processing.js`: grayscale, reference by reconstruction, difference grid and feature scaling.
- `public/engine/localization.js`: suspicious-cell regions on the difference grid.
- `public/engine/worker.js`: Brain.js training, validation and inference.
- `src/app/app.ts`: application state and interaction handling.
- `src/app/export.ts`: downloads and BMP encoding.
- `public/engine/brain.js`: local browser distribution from the installed Brain.js dependency.


