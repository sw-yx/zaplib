import { cursorMap } from "./cursor_map";
import { copyArrayToRustBuffer, getZapParamType } from "./common";
import { makeTextarea, TextareaEvent } from "./make_textarea";
import {
  CallRust,
  CallJsCallback,
  CallRustInSameThreadSync,
  ZapParam,
  PostMessageTypedArray,
  CreateBuffer,
  ZapParamType,
  Initialize,
} from "./types";
import {
  getCachedZapBuffer,
  overwriteTypedArraysWithZapArrays,
  isZapBuffer,
  checkValidZapArray,
  getZapBufferCef,
  ZapBuffer,
} from "./zap_buffer";
import { ZerdeBuilder } from "./zerde";
import { zerdeKeyboardHandlers } from "./zerde_keyboard_handlers";
import { WorkerEvent } from "./rpc_types";
import { addDefaultStyles } from "./default_styles";

type CefParams = (string | [ArrayBuffer, ZapParamType])[];
type CefBufferData = [ArrayBuffer, number | undefined, ZapParamType];
type FromCefParams = (string | CefBufferData)[];
declare global {
  interface Window {
    // Defined externally in `cef_browser.rs`.
    cefCallRust: (name: string, params: CefParams, callbackId: number) => void;
    cefCallRustInSameThreadSync: (
      name: string,
      params: CefParams
    ) => FromCefParams;
    cefReadyForMessages: () => void;
    cefCreateArrayBuffer: (
      size: number,
      paramType: ZapParamType
    ) => CefBufferData;
    cefHandleKeyboardEvent: (buffer: ArrayBuffer) => void;
    cefTriggerCut: () => void;
    cefTriggerCopy: () => void;
    cefTriggerPaste: () => void;
    cefTriggerSelectAll: () => void;

    fromCefSetMouseCursor: (cursor: number) => void;
    fromCefSetIMEPosition: (x: number, y: number) => void;
    fromCefCallJsFunction: (name: string, params: FromCefParams) => void;
  }
}

let newCallbackId = 0;
// keeping track of pending callbacks from rust side
const pendingCallbacks: Record<number, (arg0: ZapParam[]) => void> = {};

const transformParamsForRust = (params: ZapParam[]): CefParams =>
  params.map((param) => {
    if (typeof param === "string") {
      return param;
    } else {
      if (isZapBuffer(param.buffer)) {
        checkValidZapArray(param);
        const zapBuffer = param.buffer as ZapBuffer;
        return [
          zapBuffer.__zaplibWasmBuffer,
          getZapParamType(param, zapBuffer.readonly),
        ];
      }
      const paramType = getZapParamType(param, false);
      const [cefBuffer] = window.cefCreateArrayBuffer(param.length, paramType);
      // TODO(Dmitry): implement optimization to avoid copying when possible
      copyArrayToRustBuffer(param, cefBuffer, 0);
      return [cefBuffer, paramType];
    }
  });

export const callRust: CallRust = (name, params = []) => {
  const callbackId = newCallbackId++;
  const promise = new Promise<ZapParam[]>((resolve, _reject) => {
    pendingCallbacks[callbackId] = (data) => {
      // TODO(Dmitry): implement retrun_error on rust side and use reject(...) to communicate the error
      resolve(data);
    };
  });
  window.cefCallRust(name, transformParamsForRust(params), callbackId);
  return promise;
};

function _zaplibReturnParams(params: ZapParam[]) {
  const callbackId = JSON.parse(params[0] as string);
  pendingCallbacks[callbackId](params.slice(1));
  delete pendingCallbacks[callbackId];
}

// Initial set of framework-specific functions
const fromCefJsFunctions: Record<string, CallJsCallback> = {
  _zaplibReturnParams,
};

/// Users must call this function to register functions as runnable from
/// Rust via `[Cx::call_js]`.
export const registerCallJsCallbacks = (
  fns: Record<string, CallJsCallback>
): void => {
  // Check that all new functions are unique
  for (const key of Object.keys(fns)) {
    if (key in fromCefJsFunctions) {
      throw new Error(`Error: overwriting existing function "${key}"`);
    }
  }

  Object.assign(fromCefJsFunctions, fns);
  window.cefReadyForMessages();
};

/// Users must call this function to unregister functions as runnable from
/// Rust via `[Cx::call_js]`.
export const unregisterCallJsCallbacks = (fnNames: string[]): void => {
  fnNames.forEach((name) => {
    // Check that functions are registered
    if (!(name in fromCefJsFunctions)) {
      throw new Error(`Error: unregistering non-existent function "${name}"`);
    }

    delete fromCefJsFunctions[name];
  });
};

const transformReturnParams = (returnParams: FromCefParams) =>
  returnParams.map((param) => {
    if (typeof param === "string") {
      return param;
    } else {
      const [buffer, arcPtr, paramType] = param;
      const zapBuffer = getZapBufferCef(buffer, arcPtr, paramType);

      if (paramType === ZapParamType.String) {
        throw new Error("ZapParam buffer type called with string paramType");
      }

      // These are actually ZapArray types, since we overwrite TypedArrays in overwriteTypedArraysWithZapArrays()
      const ParamTypeToArrayConstructor = {
        [ZapParamType.U8Buffer]: Uint8Array,
        [ZapParamType.ReadOnlyU8Buffer]: Uint8Array,
        [ZapParamType.F32Buffer]: Float32Array,
        [ZapParamType.ReadOnlyF32Buffer]: Float32Array,
      };

      // Creating array with stable identity as that's what underlying underlying API expects
      return getCachedZapBuffer(
        zapBuffer,
        new ParamTypeToArrayConstructor[paramType](zapBuffer)
      );
    }
  });

// TODO(JP): Some of this code is duplicated with callRust/call_js; see if we can reuse some.
export const callRustInSameThreadSync: CallRustInSameThreadSync = (
  name,
  params = []
) =>
  transformReturnParams(
    window.cefCallRustInSameThreadSync(name, transformParamsForRust(params))
  );

export const newWorkerPort = (): MessagePort => {
  throw new Error("`newWorkerPort` is currently not supported on CEF");
};

export const serializeZapArrayForPostMessage = (
  _postMessageData: Uint8Array
): PostMessageTypedArray => {
  throw new Error(
    "`serializeZapArrayForPostMessage` is currently not supported on CEF"
  );
};

export const deserializeZapArrayFromPostMessage = (
  _postMessageData: PostMessageTypedArray
): Uint8Array => {
  throw new Error(
    "`deserializeZapArrayFromPostMessage` is currently not supported on CEF"
  );
};

export const initialize: Initialize = (initParams) =>
  new Promise<void>((resolve) => {
    overwriteTypedArraysWithZapArrays();

    window.fromCefSetMouseCursor = (cursorId) => {
      if (document.body) {
        document.body.style.cursor = cursorMap[cursorId] || "default";
      }
    };

    window.fromCefCallJsFunction = (name, params) => {
      fromCefJsFunctions[name](transformReturnParams(params));
    };

    document.addEventListener("DOMContentLoaded", () => {
      if (initParams.defaultStyles) {
        addDefaultStyles();
      }

      const { showTextIME, textareaHasFocus } = makeTextarea(
        (taEvent: TextareaEvent) => {
          const slots = 20;
          const [buffer] = window.cefCreateArrayBuffer(
            slots * 4,
            ZapParamType.U8Buffer
          );
          const zerdeBuilder = new ZerdeBuilder({
            buffer,
            byteOffset: 0,
            slots,
            growCallback: () => {
              throw new Error("Growing of this buffer is not supported");
            },
          });

          if (taEvent.type === WorkerEvent.KeyDown) {
            zerdeKeyboardHandlers.keyDown(zerdeBuilder, taEvent);
          } else if (taEvent.type === WorkerEvent.KeyUp) {
            zerdeKeyboardHandlers.keyUp(zerdeBuilder, taEvent);
          } else if (taEvent.type === WorkerEvent.TextInput) {
            zerdeKeyboardHandlers.textInput(zerdeBuilder, taEvent);
          } else if (taEvent.type === WorkerEvent.TextCopy) {
            zerdeKeyboardHandlers.textCopy(zerdeBuilder);
          }

          window.cefHandleKeyboardEvent(buffer);
        }
      );

      window.fromCefSetIMEPosition = (x: number, y: number) => {
        showTextIME({ x, y });
      };

      document.addEventListener("keydown", (event) => {
        const code = event.keyCode;

        if (event.metaKey || event.ctrlKey) {
          if (!textareaHasFocus()) {
            // TODO(JP): Maybe at some point we should use some library for these keycodes,
            // e.g. see https://stackoverflow.com/questions/1465374/event-keycode-constants
            if (code == 67 /* c */) {
              window.cefTriggerCopy();
            } else if (code == 88 /* x */) {
              window.cefTriggerCut();
            } else if (code == 65 /* a */) {
              window.cefTriggerSelectAll();
            }
          }

          // We want pastes to also be triggered when the textarea has focus, so we can
          // handle the paste event in JS.
          if (code == 86 /* v */) {
            window.cefTriggerPaste();
          }
        }
      });

      resolve();
    });
  });

// TODO(JP): See comment at CreateBuffer type.
export const createMutableBuffer: CreateBuffer = async (data) => {
  const paramType = getZapParamType(data, false);
  const [cefBuffer] = window.cefCreateArrayBuffer(data.length, paramType);
  copyArrayToRustBuffer(data, cefBuffer, 0);
  return transformReturnParams([
    [cefBuffer, undefined, paramType],
  ])[0] as typeof data;
};

// TODO(JP): See comment at CreateBuffer type.
export const createReadOnlyBuffer: CreateBuffer = async (data) => {
  const paramType = getZapParamType(data, true);
  const [cefBuffer, arcPtr] = window.cefCreateArrayBuffer(
    data.length,
    paramType
  );
  copyArrayToRustBuffer(data, cefBuffer, 0);
  return transformReturnParams([
    [cefBuffer, arcPtr, paramType],
  ])[0] as typeof data;
};
