package com.aiworkbench.remote_term_mobile

import android.content.Intent
import androidx.core.content.FileProvider
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.android.FlutterActivity
import io.flutter.plugin.common.MethodChannel
import java.io.File

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "ai_workbench_mobile/installer"
        ).setMethodCallHandler { call, result ->
            if (call.method != "installApk") {
                result.notImplemented()
                return@setMethodCallHandler
            }

            val path = call.argument<String>("path")
            if (path.isNullOrBlank()) {
                result.error("INVALID_PATH", "APK path is empty.", null)
                return@setMethodCallHandler
            }

            try {
                val sourceApk = File(path)
                val apkFile = if (sourceApk.parentFile == cacheDir) {
                    sourceApk
                } else {
                    val cachedApk = File(cacheDir, sourceApk.name)
                    sourceApk.copyTo(cachedApk, overwrite = true)
                    cachedApk
                }
                val apkUri = FileProvider.getUriForFile(
                    this,
                    "${applicationContext.packageName}.fileprovider",
                    apkFile
                )
                val intent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(apkUri, "application/vnd.android.package-archive")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                startActivity(intent)
                result.success(null)
            } catch (error: Exception) {
                result.error("INSTALL_FAILED", error.message, null)
            }
        }
    }
}
