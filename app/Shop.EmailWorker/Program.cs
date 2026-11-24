using Shop.EmailWorker;
using Shop.Messaging;

// Requirement 4: a separate program (its own container) that only sends the order confirmation emails.
// It can be stopped and started without touching the shop: the messages wait in RabbitMQ.
var builder = Host.CreateApplicationBuilder(args);

builder.Services.Configure<RabbitMqOptions>(builder.Configuration.GetSection(RabbitMqOptions.SectionName));

// A missing SMTP host or sender stops the worker at startup, not at the first email.
builder.Services.AddOptions<SmtpOptions>()
    .Bind(builder.Configuration.GetSection(SmtpOptions.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();

builder.Services.AddSingleton<EmailSender>();
builder.Services.AddHostedService<OrderEmailConsumer>();

builder.Build().Run();
