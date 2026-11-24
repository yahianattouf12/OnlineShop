using Microsoft.EntityFrameworkCore;

namespace Shop.Api.Modules.Orders;

public class OrdersDbContext : DbContext
{
    public DbSet<Order> Orders { get; set; }
    
    // Requirement 4: events waiting to be sent to RabbitMQ (see OutboxMessage).
    public DbSet<OutboxMessage> OutboxMessages { get; set; }


    public OrdersDbContext(DbContextOptions<OrdersDbContext> options) : base(options)
    {
    }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        modelBuilder.HasDefaultSchema("orders");

        modelBuilder.Entity<Order>(entity =>
        {
            entity.HasKey(o => o.Id);
            entity.Property(o => o.Status).HasConversion<string>().HasMaxLength(20); // stored as "Pending", readable in psql
            entity.Property(o => o.TotalAmount).HasPrecision(12, 2);
            entity.Property(o => o.Version).IsRowVersion(); // maps to PostgreSQL's xmin column

            entity.HasIndex(o => o.UserId); // "my orders" is the most common query
            entity.HasIndex(o => o.CreatedAt);

            // Requirement 3: the exact order of the order list (CreatedAt DESC, then Id). PostgreSQL reads the
            // index already sorted, so it does not have to sort orders with the same CreatedAt itself.
            entity.HasIndex(o => new { o.CreatedAt, o.Id })
                .IsDescending(true, false);

            // Foreign keys inside the module are fine.
            entity.HasMany(o => o.Items).WithOne().HasForeignKey(i => i.OrderId).OnDelete(DeleteBehavior.Cascade);
            entity.HasMany(o => o.StatusHistory).WithOne().HasForeignKey(h => h.OrderId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<OrderItem>(entity =>
        {
            entity.ToTable("OrderItems");
            entity.HasKey(i => i.Id);
            entity.Property(i => i.Id).ValueGeneratedNever(); // we set the Guid ourselves
            entity.Property(i => i.ProductName).HasMaxLength(200);
            entity.Property(i => i.UnitPrice).HasPrecision(10, 2);
            // ProductId has no foreign key on purpose: products live in another module.
        });

        modelBuilder.Entity<OutboxMessage>(entity =>
        {
            entity.ToTable("OutboxMessages");
            entity.HasKey(m => m.Id);
            entity.Property(m => m.Id).ValueGeneratedNever(); // the event's own id
            entity.Property(m => m.Type).HasMaxLength(100);
            entity.Property(m => m.Payload).HasColumnType("jsonb"); // readable and queryable in psql
            // OutboxPublisher asks for "not published yet, oldest first" every second. A partial index holds only
            // those rows, so it stays tiny however many messages were sent before.
            entity.HasIndex(m => m.CreatedAt).HasFilter("\"PublishedAt\" IS NULL");
        });


        modelBuilder.Entity<OrderStatusChange>(entity =>
        {
            entity.ToTable("OrderStatusHistory");
            entity.HasKey(h => h.Id);
            //! i should review this comment, it is not clear what it means
            // We set the Guid ourselves. Without this, EF thinks a new history row added to an
            // existing order is an old row, sends UPDATE instead of INSERT, and the save fails.
            entity.Property(h => h.Id).ValueGeneratedNever();
            entity.Property(h => h.Status).HasConversion<string>().HasMaxLength(20);
        });
    }
}
