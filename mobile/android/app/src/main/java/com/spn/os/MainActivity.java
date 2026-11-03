package com.spn.os;

import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.ViewGroup.MarginLayoutParams;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

/* SPN-MAINACTIVITY-2: written by mobile/scripts/patch-android.mjs (keyboard insets, downloads plugin) */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Saves exports to Downloads and posts the "Download complete" notification.
        registerPlugin(SpnDownloadsPlugin.class);
        super.onCreate(savedInstanceState);
        // Same condition as Capacitor's "auto" edge-to-edge margins: Android 15+ without the opt-out.
        if (Build.VERSION.SDK_INT < 35 || getBridge() == null) return;
        TypedValue value = new TypedValue();
        boolean optedOut = getTheme().resolveAttribute(android.R.attr.windowOptOutEdgeToEdgeEnforcement, value, true) && value.data != 0;
        if (optedOut) return;
        WebView webView = getBridge().getWebView();
        if (webView == null) return;
        // Replaces Capacitor's handler: keep clear of the system bars, and of the keyboard while it is open.
        ViewCompat.setOnApplyWindowInsetsListener(webView, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            MarginLayoutParams mlp = (MarginLayoutParams) v.getLayoutParams();
            mlp.leftMargin = bars.left;
            mlp.rightMargin = bars.right;
            mlp.topMargin = bars.top;
            mlp.bottomMargin = Math.max(bars.bottom, ime.bottom);
            v.setLayoutParams(mlp);
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(webView);
    }
}
