// Import workers inline, so you can just include a single file "wasm_runtime.js"
// without having to worry about having to serve multiple chunks.
// @ts-ignore
import MainWorker from "worker-loader?inline=no-fallback!./main_worker";
// @ts-ignore
import AsyncWorker from "worker-loader?inline=no-fallback!./async_worker";
// @ts-ignore
import TaskWorker from "worker-loader?inline=no-fallback!./task_worker";

import {
  getZapBufferWasm,
  isZapBuffer,
  overwriteTypedArraysWithZapArrays,
  unregisterMutableBuffer,
  ZapBuffer,
  checkValidZapArray,
} from "./zap_buffer";
import {
  createErrorCheckers,
  getZapParamType,
  initTaskWorkerSab,
  Rpc,
  transformParamsFromRustImpl,
} from "./common";
import { makeTextarea, TextareaEvent } from "./make_textarea";
import {
  CallRust,
  CallJsCallback,
  PostMessageTypedArray,
  CallRustInSameThreadSync,
  SizingData,
  TlsAndStackData,
  ZapArray,
  CreateBuffer,
  FileHandle,
  MutableBufferData,
  RustZapParam,
  Initialize,
} from "./types";
import { WebGLRenderer } from "./webgl_renderer";
import {
  makeRpcMouseEvent,
  makeRpcTouchEvent,
  makeRpcWheelEvent,
} from "./make_rpc_event";
import {
  AsyncWorkerRpc,
  WasmWorkerRpc,
  WorkerEvent,
  TaskWorkerEvent,
  AsyncWorkerEvent,
} from "./rpc_types";
import {
  addLoadingIndicator,
  removeLoadingIndicator,
} from "./loading_indicator";
import { addDefaultStyles } from "./default_styles";
import { inWorker } from "./type_of_runtime";

declare global {
  interface Document {
    ExitFullscreen?: () => Promise<void>;
    webkitExitFullscreen?: () => Promise<void>;
    mozExitFullscreen?: () => Promise<void>;
    webkitFullscreenEnabled?: () => Promise<void>;
    mozFullscreenEnabled?: () => Promise<void>;
    webkitFullscreenElement?: () => Promise<void>;
    mozFullscreenElement?: () => Promise<void>;
  }
  interface HTMLElement {
    mozRequestFullscreen?: () => Promise<void>;
    webkitRequestFullscreen?: () => Promise<void>;
  }
}

type CanvasData = {
  // Set to undefined if there's no canvas to render to. Set to OffscreenCanvas
  // if the browser supports that. Otherwise we use the WebGLRenderer on this thread.
  renderingMethod: OffscreenCanvas | WebGLRenderer | undefined;
  getSizingData: () => SizingData;
  onScreenResize: () => void;
};

const jsFunctions: Record<string, CallJsCallback> = {};

/// Users must call this function to register functions as runnable from
/// Rust via `[Cx::call_js]`.
export const registerCallJsCallbacks = (
  fns: Record<string, CallJsCallback>
): void => {
  // Check that all new functions are unique
  for (const key of Object.keys(fns)) {
    if (key in jsFunctions) {
      throw new Error(
        `Error: overwriting existing function "${key}" in window.jsFunctions`
      );
    }
  }

  Object.assign(jsFunctions, fns);
};
/// Users must call this function to unregister functions as runnable from
/// Rust via `[Cx::call_js]`.
export const unregisterCallJsCallbacks = (fnNames: string[]): void => {
  for (const name of fnNames) {
    // Check that functions are registered
    if (!(name in jsFunctions)) {
      throw new Error(`Error: unregistering non-existent function "${name}".`);
    }

    delete jsFunctions[name];
  }
};

const wasmOnline = new Uint8Array(new SharedArrayBuffer(1));
Atomics.store(wasmOnline, 0, 0);
const wasmInitialized = () => Atomics.load(wasmOnline, 0) === 1;
const { checkWasm } = createErrorCheckers(wasmInitialized);

// Wrap RPC so we can globally catch Rust panics
let _rpc: Rpc<WasmWorkerRpc>;
const rpc: Pick<typeof _rpc, "send" | "receive"> = {
  send: async (...args) => {
    try {
      return await _rpc.send(...args);
    } catch (ev) {
      if (ev instanceof Error && ev.name === "RustPanic") {
        Atomics.store(wasmOnline, 0, 0);
      }
      throw ev;
    }
  },
  receive: (...args) => _rpc.receive(...args),
};

export const newWorkerPort = (): MessagePort => {
  const channel = new MessageChannel();
  rpc.send(WorkerEvent.BindMainWorkerPort, channel.port1, [channel.port1]);
  return channel.port2;
};

let wasmMemory: WebAssembly.Memory;

const destructor = (arcPtr: number) => {
  rpc.send(WorkerEvent.DecrementArc, arcPtr);
};

const mutableDestructor = (bufferData: MutableBufferData) => {
  rpc.send(WorkerEvent.DeallocVec, bufferData);
};

const transformParamsFromRust = (params: RustZapParam[]) =>
  transformParamsFromRustImpl(
    wasmMemory,
    destructor,
    mutableDestructor,
    params
  );

// TODO(JP): Somewhat duplicated with the other implementation.
const temporarilyHeldBuffersForPostMessage = new Set();
export const serializeZapArrayForPostMessage = (
  zapArray: ZapArray
): PostMessageTypedArray => {
  if (!(typeof zapArray === "object" && isZapBuffer(zapArray.buffer))) {
    throw new Error("Only pass Zap arrays to serializeZapArrayForPostMessage");
  }
  const zapBuffer = zapArray.buffer as ZapBuffer;

  if (zapBuffer.__zaplibBufferData.readonly) {
    // Store the buffer temporarily until we've received confirmation that the Arc has been incremented.
    // Otherwise it might get garbage collected and deallocated (if the Arc's count was 1) before it gets
    // incremented.
    temporarilyHeldBuffersForPostMessage.add(zapBuffer);
    rpc
      .send(WorkerEvent.IncrementArc, zapBuffer.__zaplibBufferData.arcPtr)
      .then(() => {
        temporarilyHeldBuffersForPostMessage.delete(zapBuffer);
      });
  } else {
    unregisterMutableBuffer(zapBuffer);
  }

  return {
    bufferData: zapBuffer.__zaplibBufferData,
    byteOffset: zapArray.byteOffset,
    byteLength: zapArray.byteLength,
  };
};

export const callRust: CallRust = async (name, params = []) => {
  checkWasm();

  const transformedParams = params.map((param) => {
    if (typeof param === "string") {
      return param;
    } else if (isZapBuffer(param.buffer)) {
      checkValidZapArray(param);
      return serializeZapArrayForPostMessage(param);
    } else {
      if (!(param.buffer instanceof SharedArrayBuffer)) {
        console.warn(
          "Consider passing Uint8Arrays backed by ZapBuffer or SharedArrayBuffer into `callRust` to prevent copying data"
        );
      }
      return param;
    }
  });

  return transformParamsFromRust(
    await rpc.send(WorkerEvent.CallRust, { name, params: transformedParams })
  );
};

export const createMutableBuffer: CreateBuffer = async (data) => {
  checkWasm();

  const bufferLen = data.byteLength;
  const bufferPtr = await rpc.send(WorkerEvent.CreateBuffer, data, [
    data.buffer,
  ]);

  return transformParamsFromRust([
    {
      paramType: getZapParamType(data, false),
      bufferPtr,
      bufferLen,
      bufferCap: bufferLen,
      readonly: false,
    },
  ])[0] as typeof data;
};

export const createReadOnlyBuffer: CreateBuffer = async (data) => {
  checkWasm();

  const bufferLen = data.byteLength;
  const { bufferPtr, arcPtr } = await rpc.send(
    WorkerEvent.CreateReadOnlyBuffer,
    data,
    [data.buffer]
  );

  return transformParamsFromRust([
    {
      paramType: getZapParamType(data, true),
      bufferPtr,
      bufferLen,
      arcPtr,
      readonly: true,
    },
  ])[0] as typeof data;
};

export const deserializeZapArrayFromPostMessage = (
  postMessageData: PostMessageTypedArray
): Uint8Array => {
  const zapBuffer = getZapBufferWasm(
    wasmMemory,
    postMessageData.bufferData,
    destructor,
    mutableDestructor
  );
  return new Uint8Array(
    zapBuffer,
    postMessageData.byteOffset,
    postMessageData.byteLength
  );
};

export const callRustInSameThreadSync: CallRustInSameThreadSync = (
  name,
  _params = []
) => {
  throw new Error(
    "`callRustInSameThreadSync` is currently not supported on the main thread in WASM"
  );
};

function initializeCanvas(canvas: HTMLCanvasElement): CanvasData {
  canvas.className = "zaplib_canvas";

  document.addEventListener("contextmenu", (event) => {
    if (
      event.target instanceof Element &&
      !document.getElementById("zaplib_js_root")?.contains(event.target)
    ) {
      event.preventDefault();
    }
  });

  document.addEventListener("mousedown", (event) => {
    if (wasmInitialized())
      rpc.send(WorkerEvent.CanvasMouseDown, makeRpcMouseEvent(event));
  });
  window.addEventListener("mouseup", (event) => {
    if (wasmInitialized())
      rpc.send(WorkerEvent.WindowMouseUp, makeRpcMouseEvent(event));
  });
  window.addEventListener("mousemove", (event) => {
    document.body.scrollTop = 0;
    document.body.scrollLeft = 0;
    if (wasmInitialized())
      rpc.send(WorkerEvent.WindowMouseMove, makeRpcMouseEvent(event));
  });
  window.addEventListener("mouseout", (event) => {
    if (wasmInitialized())
      rpc.send(WorkerEvent.WindowMouseOut, makeRpcMouseEvent(event));
  });

  document.addEventListener(
    "touchstart",
    (event: TouchEvent) => {
      event.preventDefault();
      if (wasmInitialized())
        rpc.send(WorkerEvent.WindowTouchStart, makeRpcTouchEvent(event));
    },
    { passive: false }
  );
  window.addEventListener(
    "touchmove",
    (event: TouchEvent) => {
      event.preventDefault();
      if (wasmInitialized())
        rpc.send(WorkerEvent.WindowTouchMove, makeRpcTouchEvent(event));
    },
    { passive: false }
  );
  const touchEndCancelLeave = (event: TouchEvent) => {
    event.preventDefault();
    if (wasmInitialized())
      rpc.send(WorkerEvent.WindowTouchEndCancelLeave, makeRpcTouchEvent(event));
  };
  window.addEventListener("touchend", touchEndCancelLeave);
  window.addEventListener("touchcancel", touchEndCancelLeave);

  document.addEventListener("wheel", (event) => {
    if (wasmInitialized())
      rpc.send(WorkerEvent.CanvasWheel, makeRpcWheelEvent(event));
  });
  window.addEventListener("focus", () => {
    if (wasmInitialized()) rpc.send(WorkerEvent.WindowFocus);
  });
  window.addEventListener("blur", () => {
    if (wasmInitialized()) rpc.send(WorkerEvent.WindowBlur);
  });

  const isMobileSafari = self.navigator.platform.match(/iPhone|iPad/i);
  const isAndroid = self.navigator.userAgent.match(/Android/i);

  if (!isMobileSafari && !isAndroid) {
    // mobile keyboards are unusable on a UI like this
    const { showTextIME } = makeTextarea((taEvent: TextareaEvent) => {
      if (wasmInitialized()) rpc.send(taEvent.type, taEvent);
    });
    rpc.receive(WorkerEvent.ShowTextIME, showTextIME);
  }

  const getSizingData = () => {
    const canFullscreen = !!(
      document.fullscreenEnabled ||
      document.webkitFullscreenEnabled ||
      document.mozFullscreenEnabled
    );
    const isFullscreen = !!(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullscreenElement
    );
    return {
      width: canvas.offsetWidth,
      height: canvas.offsetHeight,
      dpiFactor: window.devicePixelRatio,
      canFullscreen,
      isFullscreen,
    };
  };

  let webglRenderer: WebGLRenderer;

  const onScreenResize = () => {
    // TODO(JP): Some day bring this back?
    // if (is_add_to_homescreen_safari) { // extremely ugly. but whatever.
    //     if (window.orientation == 90 || window.orientation == -90) {
    //         h = screen.width;
    //         w = screen.height - 90;
    //     }
    //     else {
    //         w = screen.width;
    //         h = screen.height - 80;
    //     }
    // }

    const sizingData = getSizingData();
    if (webglRenderer) {
      webglRenderer.resize(sizingData);
    }
    if (wasmInitialized()) rpc.send(WorkerEvent.ScreenResize, sizingData);
  };
  window.addEventListener("resize", () => onScreenResize());
  window.addEventListener("orientationchange", () => onScreenResize());

  let dpiFactor = window.devicePixelRatio;
  const mqString = "(resolution: " + window.devicePixelRatio + "dppx)";
  const mq = matchMedia(mqString);
  if (mq && mq.addEventListener) {
    mq.addEventListener("change", () => onScreenResize());
  } else {
    // poll for it. yes. its terrible
    self.setInterval(() => {
      if (window.devicePixelRatio != dpiFactor) {
        dpiFactor = window.devicePixelRatio;
        onScreenResize();
      }
    }, 1000);
  }

  // If the browser supports OffscreenCanvas, then we'll use that. Otherwise, we render on
  // the browser's main thread using WebGLRenderer.
  let renderingMethod: OffscreenCanvas | WebGLRenderer;
  try {
    renderingMethod = canvas.transferControlToOffscreen();
  } catch (_) {
    webglRenderer = new WebGLRenderer(
      canvas,
      wasmMemory,
      getSizingData(),
      () => {
        rpc.send(WorkerEvent.ShowIncompatibleBrowserNotification);
      }
    );
    rpc.receive(WorkerEvent.RunWebGL, (zerdeParserPtr) => {
      webglRenderer.processMessages(zerdeParserPtr);
      return new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve(undefined);
        });
      });
    });
    renderingMethod = webglRenderer;
  }

  return { renderingMethod, onScreenResize, getSizingData };
}

let alreadyCalledInitialize = false;
export const initialize: Initialize = (initParams) => {
  if (alreadyCalledInitialize) {
    throw new Error("Only call zaplib.initialize() once");
  }
  alreadyCalledInitialize = true;

  if (inWorker) {
    throw new Error(
      "zaplib.initialize() can only be called on the browser's main thread"
    );
  }

  overwriteTypedArraysWithZapArrays();

  return new Promise<void>((resolve) => {
    _rpc = new Rpc(new MainWorker());

    const baseUri =
      initParams.baseUri ??
      window.location.protocol + "//" + window.location.host + "/";

    let wasmModulePromise: Promise<WebAssembly.Module>;
    if (typeof initParams.wasmModule == "string") {
      const wasmPath = new URL(initParams.wasmModule, baseUri).href;
      // Safari (as of version 15.2) needs the WebAssembly Module to be compiled on the browser's
      // main thread. This also allows us to start compiling while still waiting for the DOM to load.
      wasmModulePromise = WebAssembly.compileStreaming(fetch(wasmPath));
    } else {
      wasmModulePromise = initParams.wasmModule;
    }

    // TODO(JP): These file handles are only sent to a worker when it starts running;
    // it currently can't receive any file handles added after that.
    const fileHandles: FileHandle[] = [];

    const loader = () => {
      if (initParams.defaultStyles) {
        addDefaultStyles();
        addLoadingIndicator();
      }

      // Some browsers (e.g. Safari 15.2) require SharedArrayBuffers to be initialized
      // on the browser's main thread; so that's why this has to happen here.
      //
      // We also do this before initializing `WebAssembly.Memory`, to make sure we have
      // enough memory for both.. (This is mostly relevant on mobile; see note below.)
      const taskWorkerSab = initTaskWorkerSab();
      const taskWorkerRpc = new Rpc(new TaskWorker());
      taskWorkerRpc.send(TaskWorkerEvent.Init, {
        taskWorkerSab,
        wasmMemory,
      });

      // Initial has to be equal to or higher than required by the app (which at the time of writing
      // is around 20 pages).
      // Maximum has to be equal to or lower than that of the app, which we've currently set to
      // the maximum for wasm32 (4GB). Browsers should use virtual memory, as to not actually take up
      // all this space until requested by the app. TODO(JP): We might need to check this behavior in
      // different browsers at some point (in Chrome it seems to work fine).
      //
      // In Safari on my phone (JP), using maximum:65535 causes an out-of-memory error, so we instead
      // try a hardcoded value of ~400MB.. Note that especially on mobile, all of
      // this is quite tricky; see e.g. https://github.com/WebAssembly/design/issues/1397
      //
      // TODO(JP): It looks like when using shared memory, the maximum might get fully allocated on
      // some devices (mobile?), which means that there is little room left for JS objects, and it
      // means that the web page is at higher risk of getting evicted when switching tabs. There are a
      // few options here:
      // 1. Allow the user to specify a maximum by hand for mobile in general; or for specific
      //    devices (cumbersome!).
      // 2. Allow single-threaded operation, where we don't specify a maximum (but run the risk of
      //    getting much less memory to use and therefore the app crashing; see again
      //    https://github.com/WebAssembly/design/issues/1397 for more details).
      try {
        wasmMemory = new WebAssembly.Memory({
          initial: 40,
          maximum: 65535,
          shared: true,
        });
      } catch (_) {
        console.log("Can't allocate full WebAssembly memory; trying ~400MB");
        try {
          wasmMemory = new WebAssembly.Memory({
            initial: 40,
            maximum: 6000,
            shared: true,
          });
        } catch (_) {
          throw new Error("Can't initilialize WebAssembly memory..");
        }
      }

      rpc.receive(WorkerEvent.ShowIncompatibleBrowserNotification, () => {
        const span = document.createElement("span");
        span.style.color = "white";
        span.innerHTML =
          "Sorry, we need browser support for WebGL to run<br/>Please update your browser to a more modern one<br/>Update to at least iOS 10, Safari 10, latest Chrome, Edge or Firefox<br/>Go and update and come back, your browser will be better, faster and more secure!<br/>If you are using chrome on OSX on a 2011/2012 mac please enable your GPU at: Override software rendering list:Enable (the top item) in: <a href='about://flags'>about://flags</a>. Or switch to Firefox or Safari.";
      });

      // TODO(JP): See if we can instead do this when we resolve the `initialize` Promise.
      rpc.receive(WorkerEvent.RemoveLoadingIndicators, () => {
        if (initParams.defaultStyles) {
          removeLoadingIndicator();
        }
      });

      rpc.receive(WorkerEvent.SetDocumentTitle, (title: string) => {
        document.title = title;
      });

      rpc.receive(WorkerEvent.SetMouseCursor, (style: string) => {
        document.body.style.cursor = style;
      });

      rpc.receive(WorkerEvent.Fullscreen, () => {
        if (document.body.requestFullscreen) {
          document.body.requestFullscreen();
        } else if (document.body.webkitRequestFullscreen) {
          document.body.webkitRequestFullscreen();
        } else if (document.body.mozRequestFullscreen) {
          document.body.mozRequestFullscreen();
        }
      });

      rpc.receive(WorkerEvent.Normalscreen, () => {
        if (document.exitFullscreen) {
          document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        } else if (document.mozExitFullscreen) {
          document.mozExitFullscreen();
        }
      });

      rpc.receive(WorkerEvent.TextCopyResponse, (textCopyResponse: string) => {
        window.navigator.clipboard.writeText(textCopyResponse);
      });

      rpc.receive(WorkerEvent.EnableGlobalFileDropTarget, () => {
        document.addEventListener("dragenter", (ev) => {
          const dataTransfer = ev.dataTransfer;
          // dataTransfer isn't guaranteed to exist by spec, so it must be checked
          if (
            dataTransfer &&
            dataTransfer.types.length === 1 &&
            dataTransfer.types[0] === "Files"
          ) {
            ev.stopPropagation();
            ev.preventDefault();
            dataTransfer.dropEffect = "copy";
            if (wasmInitialized()) rpc.send(WorkerEvent.DragEnter);
          }
        });
        document.addEventListener("dragover", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          if (wasmInitialized())
            rpc.send(WorkerEvent.DragOver, { x: ev.clientX, y: ev.clientY });
        });
        document.addEventListener("dragleave", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          if (wasmInitialized()) rpc.send(WorkerEvent.DragLeave);
        });
        document.addEventListener("drop", (ev) => {
          if (!ev.dataTransfer) {
            return;
          }
          const files = Array.from(ev.dataTransfer.files);
          if (!files.length) {
            return;
          }
          ev.preventDefault();
          ev.stopPropagation();
          const fileHandlesToSend: FileHandle[] = [];
          for (const file of files) {
            const fileHandle = {
              id: fileHandles.length,
              basename: file.name,
              file,
              lastReadStart: -1,
              lastReadEnd: -1,
            };
            fileHandlesToSend.push(fileHandle);
            fileHandles.push(fileHandle);
          }
          if (wasmInitialized()) {
            rpc.send(WorkerEvent.Drop, { fileHandles, fileHandlesToSend });
          }
        });
      });

      rpc.receive(WorkerEvent.CallJs, ({ fnName, params }) => {
        const fn = jsFunctions[fnName];
        if (!fn) {
          console.error(
            `call_js with ${fnName} is not available. Have you registered it using \`registerCallJsCallbacks\`?`
          );
          return;
        }

        fn(transformParamsFromRust(params));
      });

      let canvasData: CanvasData = {
        getSizingData: () => {
          // Dummy sizing data if we're not rendering.
          // TODO(JP): We should make it so we're not even sending SizingData
          // at all if we're not rendering.
          return {
            width: 0,
            height: 0,
            dpiFactor: 1,
            canFullscreen: false,
            isFullscreen: false,
          };
        },
        onScreenResize: () => {
          // Dummy function for if we're note rendering.
        },
        renderingMethod: undefined,
      };

      let canvas: HTMLCanvasElement | undefined = initParams.canvas;
      if (!canvas && initParams.defaultStyles) {
        canvas = document.createElement("canvas");
        document.body.appendChild(canvas);
      }
      if (canvas) {
        canvasData = initializeCanvas(canvas);
      }

      wasmModulePromise.then((wasmModule) => {
        // Threads need to be spawned on the browser's main thread, otherwise Safari (as of version 15.2)
        // throws errors.
        const asyncWorkers = new Set();
        const threadSpawn = ({
          ctxPtr,
          tlsAndStackData,
        }: {
          ctxPtr: BigInt;
          tlsAndStackData: TlsAndStackData;
        }) => {
          const worker = new AsyncWorker();
          const workerErrorHandler = (event: unknown) => {
            console.log("Async worker error event: ", event);
          };
          worker.onerror = workerErrorHandler;
          worker.onmessageerror = workerErrorHandler;
          const workerRpc = new Rpc<AsyncWorkerRpc>(worker);

          // Add the worker to an array of workers, to prevent them getting killed when
          // during garbage collection in Firefox; see https://bugzilla.mozilla.org/show_bug.cgi?id=1592227
          asyncWorkers.add(worker);

          const channel = new MessageChannel();
          rpc.send(WorkerEvent.BindMainWorkerPort, channel.port1, [
            channel.port1,
          ]);

          workerRpc.receive(AsyncWorkerEvent.ThreadSpawn, threadSpawn);

          workerRpc
            .send(
              AsyncWorkerEvent.Run,
              {
                wasmModule,
                memory: wasmMemory,
                taskWorkerSab,
                ctxPtr,
                fileHandles,
                baseUri,
                tlsAndStackData,
                mainWorkerPort: channel.port2,
              },
              [channel.port2]
            )
            .catch((e) => {
              console.error("async worker failed", e);
            })
            .finally(() => {
              worker.terminate();
              asyncWorkers.delete(worker);
            });
        };
        rpc.receive(WorkerEvent.ThreadSpawn, threadSpawn);

        const offscreenCanvas =
          self.OffscreenCanvas &&
          canvasData.renderingMethod instanceof OffscreenCanvas
            ? canvasData.renderingMethod
            : undefined;
        rpc
          .send(
            WorkerEvent.Init,
            {
              wasmModule,
              offscreenCanvas,
              sizingData: canvasData.getSizingData(),
              baseUri,
              memory: wasmMemory,
              taskWorkerSab,
              wasmOnline,
            },
            offscreenCanvas ? [offscreenCanvas] : []
          )
          .then(() => {
            canvasData.onScreenResize();
            resolve();
          });
      });
    };

    if (document.readyState !== "loading") {
      loader();
    } else {
      document.addEventListener("DOMContentLoaded", loader);
    }
  });
};
