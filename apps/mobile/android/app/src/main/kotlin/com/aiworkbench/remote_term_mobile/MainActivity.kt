package com.aiworkbench.remote_term_mobile

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
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
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                    !packageManager.canRequestPackageInstalls()
                ) {
                    val settingsIntent = Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:$packageName")
                    ).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    startActivity(settingsIntent)
                    result.error(
                        "INSTALL_PERMISSION_REQUIRED",
                        "请先允许 AI Workbench 安装未知来源应用，然后重新安装。",
                        null
                    )
                    return@setMethodCallHandler
                }

                val apkFile = File(path)
                if (!apkFile.exists() || apkFile.length() <= 0) {
                    result.error("INVALID_APK", "APK file is missing or empty.", null)
                    return@setMethodCallHandler
                }

                val apkUri = FileProvider.getUriForFile(
                    this,
                    "${applicationContext.packageName}.fileprovider",
                    apkFile
                )
                val intent = Intent(Intent.ACTION_INSTALL_PACKAGE).apply {
                    setDataAndType(apkUri, "application/vnd.android.package-archive")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true)
                }
                startActivity(intent)
                result.success(null)
            } catch (error: Exception) {
                result.error("INSTALL_FAILED", error.message, null)
            }
        }
    }
}
