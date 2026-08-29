// 标准 UUID v4 生成器（8-4-4-4-12，全小写，带连字符）
// 唯一来源：photoId（契约 §1.2 imageSubmit / §4.2）与 clientSaveId（契约 §5.1）统一从这里生成，
// 格式与云函数入参校验规则一致；前端各处不得再自造 ID 格式。
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

module.exports = { uuid };
