function buildTranscodeArgs(sourceUrl, isLive, skipSec, tsOffsetSec, transcodeVod=false, copyLive=false) {
  const rec = isLive ? ['-reconnect','1','-reconnect_streamed','1','-reconnect_on_network_error','1','-reconnect_delay_max','4'] : [];
  const rate = isLive ? ['-readrate','1.0','-readrate_catchup','4.0','-readrate_initial_burst','15'] : [];
  const venc = isLive
    ? copyLive ? ['-c:v','copy'] : ['-c:v','h264_videotoolbox','-realtime','1','-b:v','8M','-g','60','-pix_fmt','yuv420p']
    : transcodeVod ? ['-c:v','h264_videotoolbox','-q:v','50','-maxrate','1500k','-bufsize','3M','-g','60','-pix_fmt','yuv420p']
                   : ['-c:v','copy'];
  const aenc=(!isLive&&!transcodeVod) ? ['-c:a','copy'] : ['-c:a','aac','-b:a','160k','-ac','2'];
  const rwto = isLive ? ['-rw_timeout','30000000'] : [];
  const seek = skipSec>0.05 ? ['-ss',skipSec.toFixed(3)] : [];
  const tsoff = tsOffsetSec>0.05 ? ['-output_ts_offset',tsOffsetSec.toFixed(3)] : [];
  const prog = isLive ? [] : ['-progress','pipe:2'];
  return ['-hide_banner','-loglevel','error',...prog,...rec,...rwto,
    '-fflags','+discardcorrupt+genpts','-err_detect','ignore_err',...rate,
    '-i',sourceUrl,
    // 原生 HTTP MPEG-TS 不可 seek。输入前的 -ss 会被忽略，片尾续接时反复输出同一段。
    // 放在输入后，ffmpeg 实际读取并丢弃重叠内容，再把新片段接到已有时间轴。
    ...seek,...venc,...aenc,...tsoff,'-f','mpegts','-muxdelay','0','-muxpreload','0','pipe:1'];
}

module.exports = { buildTranscodeArgs };
