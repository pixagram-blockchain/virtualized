/**
 * Helper utility that updates the specified callback whenever any of the specified indices have changed.
 */
export default function createCallbackMemoizer(requireAllKeys = true) {
  let cachedIndices = {};
  let cachedKeys = [];

  return ({callback, indices}) => {
    const keys = Object.keys(indices);

    let allInitialized = true;
    if (requireAllKeys) {
      for (let i = 0; i < keys.length; i++) {
        const value = indices[keys[i]];
        if (Array.isArray(value) ? value.length === 0 : !(value >= 0)) {
          allInitialized = false;
          break;
        }
      }
    }

    // Allocation-free change detection: compare element-by-element instead
    // of serializing arrays with join(',') on every call.
    let indexChanged = keys.length !== cachedKeys.length;
    if (!indexChanged) {
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const cachedValue = cachedIndices[key];
        const value = indices[key];

        if (Array.isArray(value)) {
          if (
            !Array.isArray(cachedValue) ||
            cachedValue.length !== value.length
          ) {
            indexChanged = true;
            break;
          }
          for (let j = 0; j < value.length; j++) {
            if (cachedValue[j] !== value[j]) {
              indexChanged = true;
              break;
            }
          }
          if (indexChanged) {
            break;
          }
        } else if (cachedValue !== value) {
          indexChanged = true;
          break;
        }
      }
    }

    cachedIndices = indices;
    cachedKeys = keys;

    if (allInitialized && indexChanged) {
      callback(indices);
    }
  };
}
