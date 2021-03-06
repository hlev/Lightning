/**
 * Application render tree.
 * Copyright Metrological, 2017;
 */

import EventEmitter from "../EventEmitter.mjs";
import Utils from "./Utils.mjs";
import WebGLRenderer from "../renderer/webgl/WebGLRenderer.mjs";
import C2dRenderer from "../renderer/c2d/C2dRenderer.mjs";
import PlatformLoader from "../platforms/PlatformLoader.dev.mjs";

export default class Stage extends EventEmitter {

    constructor(options = {}) {
        super();
        this._setOptions(options);

        const platformType = PlatformLoader.load(options);
        this.platform = new platformType();

        if (this.platform.init) {
            this.platform.init(this);
        }

        this.gl = undefined;
        this.c2d = undefined;

        const context = this.getOption('context');
        if (context) {
            if (context.useProgram) {
                this.gl = context;
            } else {
                this.c2d = context;
            }
        } else {
            if (Utils.isWeb && (!Stage.isWebglSupported() || this.getOption('canvas2d'))) {
                this.c2d = this.platform.createCanvasContext(this.getOption('w'), this.getOption('h'));
            } else {
                this.gl = this.platform.createWebGLContext(this.getOption('w'), this.getOption('h'));
            }
        }

        this._mode = this.gl ? 0 : 1;

        // Override width and height.
        if (this.getCanvas()) {
            this._options.w = this.getCanvas().width;
            this._options.h = this.getCanvas().height;
        }

        if (this._mode === 0) {
            this._renderer = new WebGLRenderer(this);
        } else {
            this._renderer = new C2dRenderer(this);
        }

        this.setClearColor(this.getOption('clearColor'));

        this.frameCounter = 0;

        this.transitions = new TransitionManager(this);
        this.animations = new AnimationManager(this);

        this.textureManager = new TextureManager(this);

        this._destroyed = false;

        this.startTime = 0;
        this.currentTime = 0;
        this.dt = 0;

        // Preload rectangle texture, so that we can skip some border checks for loading textures.
        this.rectangleTexture = new RectangleTexture(this);
        this.rectangleTexture.load();

        // Never clean up because we use it all the time.
        this.rectangleTexture.source.permanent = true;

        this.ctx = new CoreContext(this);

        this._updateSourceTextures = new Set();
    }

    get renderer() {
        return this._renderer;
    }

    static isWebglSupported() {
        if (Utils.isNode) {
            return true;
        }

        try {
            return !!window.WebGLRenderingContext;
        } catch(e) {
            return false;
        }
    }

    /**
     * Returns the rendering mode.
     * @returns {number}
     *  0: WebGL
     *  1: Canvas2d
     */
    get mode() {
        return this._mode;
    }

    getOption(name) {
        return this._options[name];
    }

    _setOptions(o) {
        this._options = {};

        let opt = (name, def) => {
            let value = o[name];

            if (value === undefined) {
                this._options[name] = def;
            } else {
                this._options[name] = value;
            }
        }

        opt('canvas', undefined);
        opt('context', undefined);
        opt('w', 1280);
        opt('h', 720);
        opt('srcBasePath', null);
        opt('textureMemory', 18e6);
        opt('renderTextureMemory', 12e6);
        opt('bufferMemory', 2e6);
        opt('textRenderIssueMargin', 0);
        opt('clearColor', [0, 0, 0, 0]);
        opt('defaultFontFace', 'Sans-Serif');
        opt('fixedDt', 0);
        opt('useTextureAtlas', false);
        opt('debugTextureAtlas', false);
        opt('useImageWorker', false);
        opt('autostart', true);
        opt('precision', 1);
        opt('canvas2d', false);
        opt('platform', undefined);
    }

    setApplication(app) {
        this.application = app;
    }

    init() {
        this.application.setAsRoot();
        if (this.getOption('autostart')) {
            this.platform.startLoop();
        }
    }

    destroy() {
        if (!this._destroyed) {
            this.application.destroy();
            this.platform.stopLoop();
            this.ctx.destroy();
            this.textureManager.destroy();
            this._renderer.destroy();
            this._destroyed = true;
        }
    }

    stop() {
        this.platform.stopLoop();
    }

    resume() {
        if (this._destroyed) {
            throw new Error("Already destroyed");
        }
        this.platform.startLoop();
    }

    get root() {
        return this.application;
    }

    getCanvas() {
        return this._mode ? this.c2d.canvas : this.gl.canvas;
    }

    getRenderPrecision() {
        return this._options.precision;
    }

    /**
     * Marks a texture for updating it's source upon the next drawFrame.
     * @param texture
     */
    addUpdateSourceTexture(texture) {
        if (this._updatingFrame) {
            // When called from the upload loop, we must immediately load the texture in order to avoid a 'flash'.
            texture._performUpdateSource();
        } else {
            this._updateSourceTextures.add(texture);
        }
    }

    removeUpdateSourceTexture(texture) {
        if (this._updateSourceTextures) {
            this._updateSourceTextures.delete(texture);
        }
    }

    drawFrame() {
        this.startTime = this.currentTime;
        this.currentTime = this.platform.getHrTime();

        if (this._options.fixedDt) {
            this.dt = this._options.fixedDt;
        } else {
            this.dt = (!this.startTime) ? .02 : .001 * (this.currentTime - this.startTime);
        }

        this.emit('frameStart');

        if (this.textureManager.isFull()) {
            this.textureManager.freeUnusedTextureSources();
        }

        if (this._updateSourceTextures.size) {
            this._updateSourceTextures.forEach(texture => {
                texture._performUpdateSource();
            });
            this._updateSourceTextures = new Set();
        }

        this.emit('update');

        const changes = this.ctx.hasRenderUpdates();

        if (changes) {
            this._updatingFrame = true;
            this.ctx.frame();
            this._updatingFrame = false;
        }

        this.platform.nextFrame(changes);

        this.emit('frameEnd');

        this.frameCounter++;
    }

    renderFrame() {
        this.ctx.frame();
    }

    forceRenderUpdate() {
        // Enforce re-rendering.
        if (this.root) {
            this.root.core._parent.setHasRenderUpdates(1);
        }
    }

    setClearColor(clearColor) {
        this.forceRenderUpdate();
        if (clearColor === null || clearColor === undefined) {
            // Do not clear.
            this._clearColor = undefined;
        } else if (Array.isArray(clearColor)) {
            this._clearColor = clearColor;
        } else {
            this._clearColor = StageUtils.getRgbaComponentsNormalized(clearColor);
        }
    }

    getClearColor() {
        return this._clearColor;
    }

    createView() {
        return new View(this);
    }

    view(settings) {
        if (settings.isView) return settings;

        let view;
        if (settings.type) {
            view = new settings.type(this);
        } else {
            view = new View(this);
        }

        view.patch(settings, true);

        return view;
    }

    c(settings) {
        return this.view(settings);
    }

    get w() {
        return this._options.w;
    }

    get h() {
        return this._options.h;
    }

    get rw() {
        return this.w / this._options.precision;
    }

    get rh() {
        return this.h / this._options.precision;
    }

    gcTextureMemory(aggressive = false) {
        console.log("GC texture memory" + (aggressive ? " (aggressive)" : ""));
        if (aggressive && this.ctx.root.visible) {
            // Make sure that ALL textures are cleaned;
            this.ctx.root.visible = false;
            this.textureManager.freeUnusedTextureSources();
            this.ctx.root.visible = true;
        } else {
            this.textureManager.freeUnusedTextureSources();
        }
    }

    gcRenderTextureMemory(aggressive = false) {
        console.log("GC texture render memory" + (aggressive ? " (aggressive)" : ""));
        if (aggressive && this.root.visible) {
            // Make sure that ALL render textures are cleaned;
            this.root.visible = false;
            this.ctx.freeUnusedRenderTextures(0);
            this.root.visible = true;
        } else {
            this.ctx.freeUnusedRenderTextures(0);
        }
    }

    getDrawingCanvas() {
        return this.platform.getDrawingCanvas();
    }

    patchObject(object, settings) {
        settings = Base.preparePatchSettings(settings, this.getPatchId());
        Base.patchObject(object, settings);
    }

    getPatchId() {
        return this.renderer.getPatchId();
    }

}

import View from "./View.mjs";
import StageUtils from "./StageUtils.mjs";
import TextureManager from "./TextureManager.mjs";
import CoreContext from "./core/CoreContext.mjs";
import TransitionManager from "../animation/TransitionManager.mjs";
import AnimationManager from "../animation/AnimationManager.mjs";
import RectangleTexture from "../textures/RectangleTexture.mjs";
import Base from "./Base.mjs";
