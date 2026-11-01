// Fix for brain.js 2.0.0-beta.24 GPU build: input texture was sized by the hidden layer.
class IntensityNetworkGPU extends brain.NeuralNetworkGPU {
  buildRunInput() {
    super.buildRunInput();
    this.texturizeInputData.setOutput([this.sizes[0]]);
  }
}
