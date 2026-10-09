package com.example.jinbao.desktoplogin;

import android.os.Bundle;
import android.text.InputFilter;
import android.text.TextUtils;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import com.example.jinbao.GameStateManager;
import org.json.JSONObject;
import java.io.IOException;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/** Independent desktop pairing; approval always requires explicit confirmation. */
public final class DesktopLoginActivity extends AppCompatActivity {
    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).build();
    private EditText code;
    private TextView status;
    private Button inspect;
    private Call pending;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (24 * getResources().getDisplayMetrics().density);
        root.setPadding(padding, padding, padding, padding);
        TextView title = new TextView(this);
        title.setText("连接电脑"); title.setTextSize(24); root.addView(title);
        TextView help = new TextView(this);
        help.setText("先在电脑金宝设置页生成配对码。只确认你本人正在操作的电脑；电脑会获得独立会话。");
        root.addView(help);
        code = new EditText(this);
        code.setHint("8 位配对码");
        code.setSingleLine(true);
        code.setFilters(new InputFilter[]{new InputFilter.AllCaps(), new InputFilter.LengthFilter(8)});
        root.addView(code);
        inspect = new Button(this); inspect.setText("核对电脑");
        root.addView(inspect);
        status = new TextView(this); root.addView(status);
        setContentView(root);
        inspect.setOnClickListener(v -> {
            String value = code.getText().toString().trim();
            if (!value.matches("[A-F0-9]{8}")) { status.setText("请输入电脑上显示的 8 位配对码"); return; }
            if (TextUtils.isEmpty(GameStateManager.getInstance(this).getWxSessionToken())) {
                status.setText("请先返回「我」页面完成微信登录，再连接电脑"); return;
            }
            request("inspect", value, result -> {
                if (!"pending".equals(result.optString("status"))) {
                    status.setText("配对码已确认或过期，请在电脑重新生成"); return;
                }
                String device = result.optString("deviceName", "未知电脑");
                new AlertDialog.Builder(this).setTitle("确认连接电脑")
                        .setMessage("电脑：" + device + "\n配对码：" + value + "\n确认这是你本人发起的连接？")
                        .setNegativeButton("取消", null)
                        .setPositiveButton("确认连接", (dialog, which) -> request("approve", value, approved -> {
                            code.setText(""); status.setText("已确认，请回到电脑完成登录");
                        })).show();
            });
        });
    }

    private interface Result { void accept(JSONObject value); }
    private void request(String action, String value, Result result) {
        inspect.setEnabled(false); status.setText("正在验证…");
        try {
            JSONObject body = new JSONObject(); body.put("userCode", value);
            String token = GameStateManager.getInstance(this).getWxSessionToken();
            Request request = new Request.Builder()
                    .url("https://api.jinbaoai.top/desktop/auth/device/" + action)
                    .header("Authorization", "Bearer " + token)
                    .post(RequestBody.create(MediaType.parse("application/json; charset=utf-8"), body.toString())).build();
            pending = client.newCall(request);
            pending.enqueue(new Callback() {
                @Override public void onFailure(Call call, IOException failure) { update("连接失败，请稍后重试"); }
                @Override public void onResponse(Call call, Response response) throws IOException {
                    try (Response closed = response) {
                        if (!response.isSuccessful()) {
                            update(response.code() == 401 ? "登录已过期，请重新微信登录"
                                    : response.code() == 410 ? "配对码已过期，请在电脑重新生成"
                                    : response.code() == 429 ? "请求过于频繁，请稍后重试" : "无法确认，请重新生成配对码");
                            return;
                        }
                        if (response.body() == null) { update("服务响应为空"); return; }
                        String text = response.body().string();
                        if (text.length() > 8192) { update("服务响应异常"); return; }
                        JSONObject parsed = new JSONObject(text);
                        runOnUiThread(() -> { if (isFinishing() || isDestroyed()) return; inspect.setEnabled(true); status.setText(""); result.accept(parsed); });
                    } catch (Exception failure) { update("服务响应异常，请稍后重试"); }
                }
            });
        } catch (Exception failure) { update("无法发起连接，请重试"); }
    }
    private void update(String message) {
        runOnUiThread(() -> { if (!isFinishing() && !isDestroyed()) { inspect.setEnabled(true); status.setText(message); } });
    }
    @Override protected void onDestroy() {
        if (pending != null) pending.cancel();
        super.onDestroy();
    }
}
