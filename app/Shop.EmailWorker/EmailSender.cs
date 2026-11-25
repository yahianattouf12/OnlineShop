using System.Globalization;
using System.Net;
using System.Text;
using MailKit.Net.Smtp;
using MailKit.Security;
using Microsoft.Extensions.Options;
using MimeKit;
using Shop.Messaging;

namespace Shop.EmailWorker;

/// <summary>Sends the order confirmation through a real SMTP server (MailKit).</summary>
public class EmailSender
{
    private readonly SmtpOptions _smtp;

    public EmailSender(IOptions<SmtpOptions> smtp)
    {
        _smtp = smtp.Value;
    }

    /// <summary>Throws if the mail could not be sent; the caller decides whether to try again.</summary>
    public async Task SendOrderConfirmationAsync(OrderCreatedEvent order, CancellationToken ct)
    {
        var shortId = order.OrderId.ToString()[..8];

        var message = new MimeMessage();
        message.From.Add(MailboxAddress.Parse(_smtp.From));
        message.To.Add(MailboxAddress.Parse(order.CustomerEmail));
        message.Subject = $"We received your order {shortId}";
        message.Body = new BodyBuilder
        {
            TextBody = BuildText(order, shortId),
            HtmlBody = BuildHtml(order, shortId),
        }.ToMessageBody();

        using var client = new SmtpClient { Timeout = 10_000 }; // 10 s: a dead server must not block the worker
        // STARTTLS when the server offers it (Mailtrap and Gmail do): the password never travels in clear text.
        await client.ConnectAsync(_smtp.Host, _smtp.Port, SecureSocketOptions.StartTlsWhenAvailable, ct);
        if (!string.IsNullOrEmpty(_smtp.Username))
            await client.AuthenticateAsync(_smtp.Username, _smtp.Password, ct);
        await client.SendAsync(message, ct);
        await client.DisconnectAsync(quit: true, ct);
    }

    private static string BuildText(OrderCreatedEvent order, string shortId)
    {
        var text = new StringBuilder();
        text.AppendLine($"Thank you! We received your order {shortId}.");
        text.AppendLine();
        foreach (var item in order.Items)
            text.AppendLine($"  {item.Quantity} x {item.ProductName}  ({Money(item.UnitPrice)} each)");
        text.AppendLine();
        text.AppendLine($"Total: {Money(order.TotalAmount)}");
        return text.ToString();
    }

    private static string BuildHtml(OrderCreatedEvent order, string shortId)
    {
        // Product names come from the database: encode them, so a name can never inject HTML into the email.
        var rows = string.Concat(order.Items.Select(i =>
            $"<tr><td>{i.Quantity} &times; {WebUtility.HtmlEncode(i.ProductName)}</td><td align=\"right\">{Money(i.UnitPrice * i.Quantity)}</td></tr>"));
        return $"""
            <h2>Thank you! We received your order {shortId}.</h2>
            <table cellpadding="6">{rows}
            <tr><td><b>Total</b></td><td align="right"><b>{Money(order.TotalAmount)}</b></td></tr></table>
            <p>We will tell you when its status changes.</p>
            """;
    }

    private static string Money(decimal amount) => amount.ToString("0.00", CultureInfo.InvariantCulture);
}
