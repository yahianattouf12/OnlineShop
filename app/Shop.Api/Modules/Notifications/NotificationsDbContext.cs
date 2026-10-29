using Microsoft.EntityFrameworkCore;

namespace Shop.Api.Modules.Notifications;

public class NotificationsDbContext : DbContext
{
    public DbSet<Notification> Notifications { get; set; }

    public NotificationsDbContext(DbContextOptions<NotificationsDbContext> options) : base(options)
    {
    }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        modelBuilder.HasDefaultSchema("notifications");

        modelBuilder.Entity<Notification>(entity =>
        {
            entity.HasKey(n => n.Id);
            entity.Property(n => n.Message).HasMaxLength(500);

            // "My notifications, newest first" is the main query.
            entity.HasIndex(n => new { n.UserId, n.CreatedAt });
        });
    }
}
