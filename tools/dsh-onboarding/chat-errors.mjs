export function chatFailureMessage(error) {
  // 429 used to be one undifferentiated message, which made an exhausted weekly quota
  // impossible to tell apart from plain rate limiting. The cloud agent now tags the
  // pure rate-limit path with code='rate_limited' while quota denial stays
  // 'model_quota_denied', so the two can be worded differently.
  if (error?.status === 429) return error?.code === 'rate_limited'
    ? '云端请求过于频繁，已自动退避；稍等片刻会自动重试。'
    : '额度不足或请求过于频繁，请查看设置页剩余额度后重试。';
  return ({401:'登录或模型认证已失效，请到设置页重新登录或检查 API Key。',403:'当前账号没有模型服务权限，请到设置页检查。',409:'对局已切换或教练正在回复，请在当前对局重试。',502:'DSH 未能提交有效回答，请重试；若持续失败请查看维护与诊断。',503:'教练服务暂未就绪或连接中断，请到设置页检查服务状态后重试。',504:'本次分析超时，请重试；问题已保留。'})[error?.status] || '连接失败或回复超时，请检查网络和设置页服务状态后重试。';
}
