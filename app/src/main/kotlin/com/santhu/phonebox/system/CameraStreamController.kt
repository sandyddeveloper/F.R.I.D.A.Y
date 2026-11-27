package com.santhu.phonebox.system

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.hardware.camera2.*
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import androidx.core.content.ContextCompat
import org.json.JSONObject

object CameraStreamController {

    @Volatile private var latestFrame: ByteArray? = null
    @Volatile private var running = false
    @Volatile private var cameraId: String? = null

    private var cameraDevice: CameraDevice? = null
    private var captureSession: CameraCaptureSession? = null
    private var imageReader: ImageReader? = null
    private var bgThread: HandlerThread? = null
    private var bgHandler: Handler? = null

    fun start(context: Context, facingFront: Boolean = false): Boolean {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED) return false
        stop()

        val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val targetFacing = if (facingFront) CameraCharacteristics.LENS_FACING_FRONT
                           else CameraCharacteristics.LENS_FACING_BACK

        val id = manager.cameraIdList.firstOrNull { camId ->
            val chars = manager.getCameraCharacteristics(camId)
            chars.get(CameraCharacteristics.LENS_FACING) == targetFacing
        } ?: manager.cameraIdList.firstOrNull() ?: return false

        cameraId = id

        bgThread = HandlerThread("CamBg").also { it.start() }
        bgHandler = Handler(bgThread!!.looper)

        imageReader = ImageReader.newInstance(640, 480, ImageFormat.JPEG, 2).also { reader ->
            reader.setOnImageAvailableListener({ ir ->
                val image = ir.acquireLatestImage() ?: return@setOnImageAvailableListener
                try {
                    val plane = image.planes[0]
                    val buf = plane.buffer
                    val bytes = ByteArray(buf.remaining())
                    buf.get(bytes)
                    latestFrame = bytes
                } finally {
                    image.close()
                }
            }, bgHandler)
        }

        manager.openCamera(id, object : CameraDevice.StateCallback() {
            override fun onOpened(camera: CameraDevice) {
                cameraDevice = camera
                val surface = imageReader!!.surface
                camera.createCaptureSession(
                    listOf(surface),
                    object : CameraCaptureSession.StateCallback() {
                        override fun onConfigured(session: CameraCaptureSession) {
                            captureSession = session
                            val req = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                                addTarget(surface)
                                set(CaptureRequest.JPEG_QUALITY, 70)
                                set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                            }.build()
                            session.setRepeatingRequest(req, null, bgHandler)
                            running = true
                        }
                        override fun onConfigureFailed(session: CameraCaptureSession) {
                            running = false
                        }
                    },
                    bgHandler
                )
            }
            override fun onDisconnected(camera: CameraDevice) { camera.close(); running = false }
            override fun onError(camera: CameraDevice, error: Int) { camera.close(); running = false }
        }, bgHandler)

        return true
    }

    fun stop() {
        running = false
        runCatching { captureSession?.close() }
        captureSession = null
        runCatching { cameraDevice?.close() }
        cameraDevice = null
        runCatching { imageReader?.close() }
        imageReader = null
        runCatching { bgThread?.quitSafely() }
        bgThread = null
        bgHandler = null
        latestFrame = null
        cameraId = null
    }

    fun latestJpeg(): ByteArray? = latestFrame

    fun status(): JSONObject = JSONObject()
        .put("running", running)
        .put("cameraId", cameraId ?: JSONObject.NULL)
        .put("hasFrame", latestFrame != null)
}
