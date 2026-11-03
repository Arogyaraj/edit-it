// HEIC adapter for edit-it. It turns the libheif-js bundle into window.heicDecode(blob) -> Promise<ImageBitmap>.
//
// To enable HEIC, put libheif-js's browser bundle at vendor/libheif/libheif.js (it defines the global `libheif`).
// The app loads that bundle first, then this file. Without the bundle this file does nothing, and the app tells
// the user that HEIC needs the decoder.
//
// Written against libheif-js's documented API: new libheif.HeifDecoder(), decode(buffer), get_width(),
// get_height() and display(imageData, callback). It is not tested against real HEIC files in edit-it's own tests.
(function () {
  if (typeof window.libheif === 'undefined') return;
  window.heicDecode = async function (blob) {
    const buffer = await blob.arrayBuffer();
    const decoder = new window.libheif.HeifDecoder();
    const images = decoder.decode(buffer);
    if (!images || !images.length) throw new Error('No photo was found in this HEIC file.');
    const image = images[0];
    const width = image.get_width(), height = image.get_height();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const data = ctx.createImageData(width, height);
    await new Promise((resolve, reject) => {
      image.display(data, out => (out ? resolve(out) : reject(new Error('The HEIC photo could not be displayed.'))));
    }).then(out => ctx.putImageData(out || data, 0, 0));
    return createImageBitmap(canvas);
  };
})();
