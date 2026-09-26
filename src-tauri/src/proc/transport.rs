//! Bounded NDJSON framing. EOF with a final unterminated line is still a frame.
use tokio::io::{AsyncBufRead, AsyncBufReadExt};

#[derive(Debug)]
pub enum WriteFailure {
    TimedOut,
    Io(std::io::Error),
}

/// A timeout may follow a partial write. Callers must never automatically resend it.
pub async fn write_frame<W: tokio::io::AsyncWrite + Unpin>(
    writer: &mut W,
    bytes: &[u8],
    timeout: std::time::Duration,
) -> Result<(), WriteFailure> {
    use tokio::io::AsyncWriteExt;
    tokio::time::timeout(timeout, async {
        writer.write_all(bytes).await?;
        writer.flush().await
    })
    .await
    .map_err(|_| WriteFailure::TimedOut)?
    .map_err(WriteFailure::Io)
}

pub const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
// A replay may contain the complete accepted input, including base64 attachments.
pub const MAX_EVENT_BYTES: usize = MAX_INPUT_BYTES + 1024 * 1024;

pub async fn read_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    limit: usize,
) -> std::io::Result<Option<String>> {
    let mut line = Vec::new();
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            if line.is_empty() {
                return Ok(None);
            }
            break;
        }
        let end = chunk.iter().position(|b| *b == b'\n');
        let count = end.map_or(chunk.len(), |n| n + 1);
        if line.len() + count > limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "CLI output line exceeds limit",
            ));
        }
        line.extend_from_slice(&chunk[..count]);
        reader.consume(count);
        if end.is_some() {
            break;
        }
    }
    String::from_utf8(line).map(Some).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "CLI output is not UTF-8")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncWriteExt, BufReader};

    #[tokio::test]
    async fn frames_chunked_crlf_blank_and_unterminated_lines() {
        let (mut writer, reader) = tokio::io::duplex(8);
        tokio::spawn(async move {
            for part in ["{\"a\":", "1}\r", "\n\n", "tail"] {
                writer.write_all(part.as_bytes()).await.unwrap();
            }
        });
        let mut reader = BufReader::new(reader);
        assert_eq!(
            read_line(&mut reader, 64).await.unwrap().unwrap().trim(),
            "{\"a\":1}"
        );
        assert_eq!(read_line(&mut reader, 64).await.unwrap(), Some("\n".into()));
        assert_eq!(
            read_line(&mut reader, 64).await.unwrap(),
            Some("tail".into())
        );
        assert_eq!(read_line(&mut reader, 64).await.unwrap(), None);
    }

    #[tokio::test]
    async fn rejects_oversized_lines_before_unbounded_allocation() {
        let mut reader = BufReader::new(&b"123456789"[..]);
        assert_eq!(
            read_line(&mut reader, 8).await.unwrap_err().kind(),
            std::io::ErrorKind::InvalidData
        );
    }

    #[tokio::test]
    async fn blocked_writer_times_out_after_partial_delivery() {
        use tokio::io::AsyncReadExt;
        let (mut writer, mut reader) = tokio::io::duplex(8);
        assert!(matches!(
            write_frame(
                &mut writer,
                b"0123456789abcdef",
                std::time::Duration::from_millis(20)
            )
            .await,
            Err(WriteFailure::TimedOut)
        ));
        let mut received = [0; 8];
        reader.read_exact(&mut received).await.unwrap();
        assert_eq!(&received, b"01234567");
    }

    #[tokio::test]
    async fn closed_reader_reports_io_failure_without_retry() {
        let (mut writer, reader) = tokio::io::duplex(8);
        drop(reader);
        assert!(matches!(
            write_frame(
                &mut writer,
                b"payload\n",
                std::time::Duration::from_millis(20)
            )
            .await,
            Err(WriteFailure::Io(_))
        ));
    }
}
