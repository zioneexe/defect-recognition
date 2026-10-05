/* Brain.js 2.0.0-beta.24's browser GPU build sizes the input texture using
 * sizes[1] (the hidden layer) instead of sizes[0] (the input vector).
 * Preserve every intensity cell when the hidden layer has fewer neurons.
 */
class IntensityNetworkGPU extends brain.NeuralNetworkGPU {
  buildRunInput() {
    super.buildRunInput();
    this.texturizeInputData.setOutput([this.sizes[0]]);
  }
}
