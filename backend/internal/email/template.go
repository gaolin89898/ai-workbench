package email

import "fmt"

// SendVerificationCode sends a 6-digit verification code to the recipient.
// The code is valid for 10 minutes (enforced by the caller storing the
// expires_at). The template is bilingual-friendly: the HTML part is what most
// users see, the text part is the fallback for non-HTML clients.
func (s *Sender) SendVerificationCode(to, code string) error {
	subject := "[CodeHub AI] 登录验证码"
	textBody := fmt.Sprintf(
		"您正在登录 CodeHub AI。\n\n您的验证码是：%s\n\n验证码 10 分钟内有效。如果不是您本人操作，请忽略此邮件。\n",
		code,
	)
	htmlBody := fmt.Sprintf(`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:420px;margin:0 auto;padding:24px;background:#ffffff;border-radius:8px;border:1px solid #ebedf0">
  <div style="font-size:18px;font-weight:600;color:#1f2329;margin-bottom:16px">CodeHub AI 登录验证码</div>
  <p style="color:#4e5969;font-size:14px;line-height:22px;margin:0 0 20px">您正在登录 CodeHub AI。请使用下面的验证码完成登录：</p>
  <div style="text-align:center;margin:24px 0">
    <span style="display:inline-block;font-size:30px;font-weight:700;letter-spacing:8px;color:#165dff;background:#f2f3f5;border-radius:8px;padding:14px 24px">%s</span>
  </div>
  <p style="color:#86909c;font-size:12px;line-height:20px;margin:0">验证码 10 分钟内有效。如果不是您本人操作，请忽略此邮件。</p>
</div>`, code)
	return s.Send(to, subject, htmlBody, textBody)
}
