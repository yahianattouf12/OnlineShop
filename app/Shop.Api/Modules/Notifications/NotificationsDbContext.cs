using Microsoft.EntityFrameworkCore;

namespace Shop.Api.Modules.Notifications;

public class NotificationsDbContext : DbContext
{

    public NotificationsDbContext(DbContextOptions<NotificationsDbContext> options) : base(options)
    {
    }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        
        base.OnModelCreating(modelBuilder);

        modelBuilder.HasDefaultSchema("notifications");
        

    }
}